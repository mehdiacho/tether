/**
 * The session registry: what is running, what it is doing, and how to talk to it.
 *
 * ## Why this exists at all
 *
 * There is no supported third-party API for pushing a message into a running
 * Claude Code session. Discovery is easy — `claude agents --json` lists every
 * live session, and hooks fire on every meaningful transition. Delivery is not:
 * the only things that can put a message into a live session are (a) another
 * Claude session on the same machine, over Claude Code's own local peer
 * channel, and (b) a human, through claude.ai or Remote Control, whose
 * transport is Anthropic's with no third-party entry point.
 *
 * So this module is deliberately split down that seam:
 *
 *   - **Inbound** (a session telling Tether about itself) is plain HTTP from a
 *     hook. Supported, stable, and works for every session on every machine.
 *   - **Outbound** (a message going to a session) is a queue that a *relay* —
 *     itself a Claude session — drains. Tether never pretends it can deliver;
 *     it parks the message and records whether the relay managed it.
 *
 * That split is why `transport: 'none'` is a first-class value rather than an
 * error. A session with no relay is still worth showing. Hiding it, or letting
 * the composer accept text that goes nowhere, would be the actual bug.
 *
 * ## Sessions and agents
 *
 * A session is something the human started and can address. An agent is a
 * subagent some session spawned. They share a table and a shape, and are told
 * apart by `parentId`. The rule that falls out of that: **a message is only
 * ever addressed to a session.** A subagent has no inbox of its own — you
 * reach it, if at all, by talking to its parent.
 */

import { randomUUID } from 'node:crypto';
import { placeCall } from './calls.ts';
import { config } from './config.ts';
import * as store from './db.ts';
import * as requests from './requests.ts';
import type {
  AgentSession,
  SessionKind,
  SessionMessage,
  SessionState,
  SessionTransport,
} from './types.ts';

/** How long a queued message is worth delivering. */
const MESSAGE_TTL_MS = 60 * 60 * 1000;

/** One long-poll leg for a relay. Under any sane proxy read timeout. */
const OUTBOX_LEG_MS = 25_000;

/** relay name -> callbacks parked on its outbox. */
const relayWaiters = new Map<string, Set<() => void>>();

function wakeRelay(relay: string): void {
  const set = relayWaiters.get(relay);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn();
    } catch (err) {
      console.error('[tether] relay waiter failed:', err);
    }
  }
}

/* ------------------------------------------------------------ inbound -- */

export interface RegisterArgs {
  externalId: string;
  kind?: SessionKind;
  /** The tool's id for the parent, not Tether's. Hooks only know that one. */
  parentExternalId?: string | null;
  agentType?: string | null;
  title?: string;
  cwd?: string;
  tool?: string;
  transport?: SessionTransport;
  relay?: string;
  address?: string;
}

/**
 * Register a session or agent, or refresh one that already exists.
 *
 * Idempotent on purpose: `SessionStart` fires again when a session resumes, and
 * a resumed session is the same session. Minting a second row would split its
 * transcript in half and put a stale duplicate on the home page.
 */
export function register(a: RegisterArgs): AgentSession {
  const tool = a.tool?.trim() || 'claude-code';
  const kind: SessionKind = a.kind === 'agent' ? 'agent' : 'session';

  // Parents are addressed by their own tool id. Resolving here rather than in
  // the hook keeps the hook a dumb reporter: it knows its parent's session_id
  // because Claude Code hands it over, and nothing more.
  let parentId: string | null = null;
  if (a.parentExternalId) {
    parentId = store.getSessionByExternal(tool, a.parentExternalId)?.id ?? null;
  }

  // A subagent inherits reachability from its parent rather than claiming its
  // own. It has no inbox; recording a relay against it would invite the app to
  // offer a composer that cannot work.
  const transport: SessionTransport =
    kind === 'agent' ? 'none' : (a.transport ?? 'none');

  const existing = store.getSessionByExternal(tool, a.externalId);
  const session = store.upsertSession({
    id: randomUUID(),
    externalId: a.externalId,
    parentId,
    kind,
    agentType: a.agentType?.trim() || null,
    title: a.title?.trim() || defaultTitle(kind, a),
    cwd: a.cwd?.trim() || '',
    tool,
    transport,
    relay: kind === 'agent' ? '' : (a.relay?.trim() || ''),
    address: kind === 'agent' ? '' : (a.address?.trim() || ''),
  });

  if (!existing) {
    store.addSessionMessage({
      id: randomUUID(),
      sessionId: session.id,
      role: 'system',
      text: kind === 'agent' ? `Subagent started${session.agentType ? ` (${session.agentType})` : ''}.` : 'Session started.',
      delivery: '',
    });
  }
  return session;
}

function defaultTitle(kind: SessionKind, a: RegisterArgs): string {
  if (kind === 'agent') return a.agentType?.trim() || 'Subagent';
  const cwd = a.cwd?.trim() ?? '';
  // The working directory is the most recognisable thing a session has before
  // it has done anything, and it is what the human actually thinks in.
  const leaf = cwd.split(/[\\/]/).filter(Boolean).pop();
  return leaf || 'Session';
}

export interface StateArgs {
  state: SessionState;
  /** What it is blocked on. Only meaningful when `state` is 'waiting'. */
  waitingOn?: string | null;
  /** Ring the phone rather than just notifying. */
  ring?: boolean;
  /** Text to speak when ringing. Falls back to `waitingOn`. */
  say?: string;
}

/**
 * Record a state change, and interrupt the human if it is one worth being
 * interrupted for.
 *
 * Only `waiting` reaches out. A session going idle at the end of its turn is
 * the normal case and happens dozens of times an hour; notifying on it would
 * make Tether the thing you mute. `waiting` means genuinely blocked.
 */
export async function setState(id: string, a: StateArgs): Promise<AgentSession | null> {
  const before = store.getSession(id);
  if (!before) return null;

  const waitingOn = a.state === 'waiting' ? (a.waitingOn?.trim() || 'Input needed') : null;
  const session = store.setSessionState(id, a.state, waitingOn);
  if (!session) return null;

  if (a.state === 'waiting') {
    store.addSessionMessage({
      id: randomUUID(),
      sessionId: session.id,
      role: 'system',
      text: waitingOn ?? 'Input needed',
      delivery: '',
    });
  }

  // Only on the transition. A session that reports 'waiting' twice — a hook
  // firing again, a relay re-registering — must not ring twice.
  //
  // Deliberately not awaited. The caller is a hook running inline in someone's
  // session, with a timeout measured in seconds; rendering a call to speech
  // takes longer than that, so awaiting it here would mean the hook gives up
  // and the human waits, for work that finishes either way. The state change is
  // already committed, which is the part that had to be durable.
  if (a.state === 'waiting' && before.state !== 'waiting') {
    void alert(session, a.say?.trim() || waitingOn || 'Input needed', a.ring === true);
  }
  return session;
}

async function alert(session: AgentSession, text: string, ring: boolean): Promise<void> {
  const context = {
    session: session.title,
    id: session.id,
    ...(session.cwd ? { cwd: session.cwd } : {}),
  };
  try {
    if (ring) {
      await placeCall({
        text: `${session.title} needs you. ${text}`,
        title: `${session.title} needs you`,
        priority: 'urgent',
        context,
        agentName: session.title,
      });
      return;
    }
    requests.create({
      kind: 'notify',
      title: `${session.title} needs you`,
      body: text,
      priority: 'high',
      context,
      agentName: session.title,
      timeoutSec: 60,
    });
  } catch (err) {
    // A session that cannot ring is still a session that is waiting. Losing
    // the alert must not lose the state change that is already committed.
    console.error('[tether] could not alert for session', session.id, err);
  }
}

/** Something the session said, for the timeline. */
export function note(id: string, text: string): SessionMessage | null {
  const session = store.getSession(id);
  if (!session) return null;
  return store.addSessionMessage({
    id: randomUUID(),
    sessionId: session.id,
    role: 'agent',
    text,
    delivery: '',
  });
}

export function end(id: string): AgentSession | null {
  const session = store.getSession(id);
  if (!session) return null;
  store.addSessionMessage({
    id: randomUUID(),
    sessionId: session.id,
    role: 'system',
    text: 'Session ended.',
    delivery: '',
  });
  return store.setSessionState(id, 'ended', null);
}

/* ----------------------------------------------------------- outbound -- */

export class NotAddressable extends Error {}

/**
 * Queue a message for a session.
 *
 * Refuses rather than silently accepting when nothing can carry it. The app
 * should be graying out its composer in that case, but the server is where the
 * rule has to actually live — a phone with a stale session list would otherwise
 * post into a void and show the message as sent.
 */
export function send(id: string, text: string): SessionMessage {
  const session = store.getSession(id);
  if (!session) throw new NotAddressable('No such session.');
  if (session.kind === 'agent') {
    throw new NotAddressable(
      'Subagents have no inbox. Send to the session that spawned it instead.',
    );
  }
  if (session.state === 'ended') throw new NotAddressable('That session has ended.');
  if (session.transport === 'none' || !session.relay) {
    throw new NotAddressable(
      'Nothing can reach that session — it registered without a relay.',
    );
  }

  const message = store.addSessionMessage({
    id: randomUUID(),
    sessionId: session.id,
    role: 'human',
    text,
    delivery: 'queued',
  });
  wakeRelay(session.relay);
  return message;
}

export interface OutboxItem {
  message: SessionMessage;
  /** How the relay addresses the target — its peer name, not a Tether id. */
  address: string;
  sessionId: string;
  externalId: string;
  title: string;
}

function collect(relay: string): OutboxItem[] {
  store.expireQueuedMessages(MESSAGE_TTL_MS);
  return store.queuedForRelay(relay).flatMap((message) => {
    const session = store.getSession(message.sessionId);
    if (!session) return [];
    return [
      {
        message,
        address: session.address || session.externalId,
        sessionId: session.id,
        externalId: session.externalId,
        title: session.title,
      },
    ];
  });
}

/**
 * Long-poll a relay's work queue.
 *
 * Long-polling rather than a socket because a relay is a Claude session running
 * a shell command: it can hold an HTTP request open inside one tool call, and
 * it cannot hold a WebSocket across them.
 */
export function outbox(relay: string, maxWaitMs = OUTBOX_LEG_MS): Promise<OutboxItem[]> {
  const ready = collect(relay);
  if (ready.length > 0) return Promise.resolve(ready);

  return new Promise((resolve) => {
    let set = relayWaiters.get(relay);
    if (!set) {
      set = new Set();
      relayWaiters.set(relay, set);
    }
    const bucket = set;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bucket.delete(waiter);
      if (bucket.size === 0) relayWaiters.delete(relay);
      resolve(collect(relay));
    };
    const waiter = () => finish();
    const timer = setTimeout(finish, maxWaitMs);
    bucket.add(waiter);
  });
}

export function settle(
  messageId: string,
  ok: boolean,
  error?: string | null,
): SessionMessage | null {
  return store.settleMessage(messageId, ok ? 'delivered' : 'failed', ok ? null : (error ?? 'Delivery failed.'));
}

/* --------------------------------------------------------------- read -- */

export interface SessionView extends AgentSession {
  /** Preview line for the home page. */
  preview: string;
  /** Queued messages not yet delivered, so the app can show a pending badge. */
  pending: number;
  /** Direct subagents, newest first. */
  agents: AgentSession[];
}

export function view(includeEnded = false): SessionView[] {
  const all = store.listSessions(includeEnded);
  const children = new Map<string, AgentSession[]>();
  for (const s of all) {
    if (!s.parentId) continue;
    const list = children.get(s.parentId) ?? [];
    list.push(s);
    children.set(s.parentId, list);
  }
  return all
    .filter((s) => s.kind === 'session')
    .map((s) => ({
      ...s,
      preview: store.lastSessionMessage(s.id)?.text ?? '',
      pending: store.listSessionMessages(s.id).filter((m) => m.delivery === 'queued').length,
      agents: children.get(s.id) ?? [],
    }));
}

export function get(id: string): AgentSession | null {
  return store.getSession(id);
}

export function messages(id: string): SessionMessage[] {
  return store.listSessionMessages(id);
}

/**
 * Sweep sessions whose hooks stopped firing.
 *
 * A session that is killed — `kill -9`, a closed laptop, a crashed terminal —
 * never fires `SessionEnd`, so without this the home page slowly fills with
 * things that look alive and silently swallow messages. Absence of a heartbeat
 * is the only evidence available.
 */
export function sweep(): void {
  const cutoff = Date.now() - config.session.staleMs;
  for (const s of store.listSessions()) {
    if (s.lastSeenAt > cutoff) continue;
    store.setSessionState(s.id, 'ended', null);
  }
  store.pruneSessions(config.session.retainMs);
  store.expireQueuedMessages(MESSAGE_TTL_MS);
}

export function startSweeper(): () => void {
  const timer = setInterval(sweep, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
