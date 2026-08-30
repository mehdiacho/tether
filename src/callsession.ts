/**
 * Call sessions: the ring/answer/decline lifecycle that sits on top of a request.
 *
 * ## Why this is not just a field on the request
 *
 * A request is a durable question with one answer. A call is a transient event
 * with a completely different shape: it rings on several devices at once, one
 * of them picks up and the rest must stop, it can be declined without answering
 * the underlying question, and it can be missed entirely by nobody doing
 * anything. Folding that into the request row would mean "pending" meaning four
 * different things depending on which field you looked at.
 *
 * So a call gets its own row, its own state machine, and its own socket. The
 * request stays what it always was — the thing an agent is waiting on.
 *
 * ## The answer race
 *
 * Every paired device rings. Exactly one may answer. That is enforced in SQL
 * with a guarded UPDATE (`WHERE state = 'ringing'`), not in JavaScript, so it
 * holds across concurrent requests and across a restart mid-ring.
 */

import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import * as store from './db.ts';
import * as devices from './devices.ts';
import { push } from './push.ts';
import type { CallEvent, CallSession, CallTurn, TetherRequest } from './types.ts';

type Listener = (callId: string, event: CallEvent) => void;
const listeners = new Set<Listener>();

/** Subscribe to call events so the WebSocket layer can fan them out. */
export function onCallEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(callId: string, event: CallEvent): void {
  for (const fn of listeners) {
    try {
      fn(callId, event);
    } catch (err) {
      console.error('[tether] call listener failed:', err);
    }
  }
}

/* --------------------------------------------------------------- placing -- */

/**
 * The URL the app fetches the recording from.
 *
 * Deliberately the per-request action-token URL rather than a client-token one:
 * it travels inside an FCM payload, so whatever authorises it must unlock this
 * one recording and nothing else. If a push payload leaked, the blast radius is
 * a single voice message.
 */
function audioUrl(r: TetherRequest): string | null {
  if (!r.audioId) return null;
  const base = config.publicUrl || `http://localhost:${config.port}`;
  return `${base}/v/${r.id}/${r.actionToken}`;
}

/**
 * Start a call for a request: create the session, then ring every paired device.
 *
 * Push failure is not call failure. The other channels still fire, and the web
 * UI still shows it — a call that could not reach a phone is a missed call, not
 * an error the agent needs to handle.
 */
export async function ring(request: TetherRequest): Promise<CallSession> {
  const call = store.insertCall(randomUUID(), request.id);

  const tokens = devices.pushTargets();
  if (tokens.length === 0) {
    console.warn('[tether] call placed with no paired devices — nothing will ring');
    return call;
  }

  const url = audioUrl(request);
  const result = await push({
    tokens,
    // Ringing late is worse than not ringing: a call that arrives after the
    // caller gave up is pure noise. TTL matches the ring window.
    ttlSeconds: config.callRingSeconds,
    collapseKey: `call-${call.id}`,
    data: {
      type: 'call.incoming',
      callId: call.id,
      requestId: request.id,
      title: request.title,
      body: request.body,
      agent: request.agentName,
      actionToken: request.actionToken,
      ringSeconds: String(config.callRingSeconds),
      ...(url ? { audioUrl: url } : {}),
      ...(request.choices?.length ? { choices: JSON.stringify(request.choices) } : {}),
    },
  });

  devices.prunePushTokens(result.stale);
  if (result.sent === 0) {
    console.warn(`[tether] call ${call.id}: no device accepted the push`);
  }

  return call;
}

/**
 * Push a plain message (notify / ask) to every paired device.
 *
 * Same transport as a call, different `type` — the app renders one as a ringing
 * screen and the other as a message with answer buttons.
 */
export async function pushMessage(request: TetherRequest): Promise<number> {
  const tokens = devices.pushTargets();
  if (tokens.length === 0) return 0;

  const url = audioUrl(request);
  const result = await push({
    tokens,
    // A message should survive a flat battery; unlike a ring, it is still
    // worth reading an hour late.
    ttlSeconds: 24 * 60 * 60,
    collapseKey: `req-${request.id}`,
    data: {
      type: 'request.created',
      requestId: request.id,
      kind: request.kind,
      title: request.title,
      body: request.body,
      agent: request.agentName,
      priority: request.priority,
      actionToken: request.actionToken,
      ...(url ? { audioUrl: url } : {}),
      ...(request.choices?.length ? { choices: JSON.stringify(request.choices) } : {}),
    },
  });

  devices.prunePushTokens(result.stale);
  return result.sent;
}

/**
 * Tell every device a call is over, so stale ringing screens dismiss themselves.
 *
 * `exceptDeviceId` is the device that caused the ending. It must be left out:
 * a phone that has just answered is not a stale ringing screen, it is the call,
 * and telling it the call ended makes it hang up on itself.
 */
async function pushCallEnded(
  call: CallSession,
  reason: string,
  exceptDeviceId?: string,
): Promise<void> {
  const tokens = devices.pushTargets(exceptDeviceId);
  if (tokens.length === 0) return;

  const result = await push({
    tokens,
    ttlSeconds: 60,
    collapseKey: `call-${call.id}`,
    data: { type: 'call.ended', callId: call.id, reason },
  });
  devices.prunePushTokens(result.stale);
}

/* --------------------------------------------------------------- answering -- */

export interface AnswerResult {
  call: CallSession;
  request: TetherRequest | null;
  /** Speech to play, in order. Stage 1 has exactly one segment. */
  segments: { url: string; text: string; seq: number }[];
}

/**
 * Pick up. Returns null if the call was already answered, declined or missed —
 * the caller should treat that as "someone else got there first", not an error.
 */
export function answer(callId: string, deviceId: string): AnswerResult | null {
  const call = store.answerCall(callId, deviceId);
  if (!call) return null;

  const request = store.getRequest(call.requestId);
  const url = request ? audioUrl(request) : null;

  const segments = url && request ? [{ url, text: request.body, seq: 0 }] : [];

  // The opening line belongs in the transcript like any other turn. Recording it
  // here rather than when the call was placed is deliberate: nothing was said
  // until somebody picked up, and a missed call has no conversation in it.
  if (request && store.listCallTurns(call.id).length === 0) {
    store.addCallTurn({
      id: randomUUID(),
      callId: call.id,
      speaker: 'agent',
      text: request.body,
      audioId: request.audioId,
    });
  }

  emit(call.id, { type: 'call.state', state: 'answered', callId: call.id });
  for (const s of segments) emit(call.id, { type: 'call.audio', ...s });
  emit(call.id, { type: 'call.complete' });

  // Every other device is still ringing. Stop them — but not this one.
  void pushCallEnded(call, 'answered', deviceId).catch(() => {});

  return { call, request, segments };
}

export function decline(callId: string): CallSession | null {
  const call = store.finishCall(callId, 'declined');
  if (!call) return null;
  emit(call.id, { type: 'call.state', state: 'declined', callId: call.id });
  void pushCallEnded(call, 'declined').catch(() => {});
  return call;
}

/**
 * Hang up.
 *
 * `exceptDeviceId` is the phone that hung up, when a phone is what did it. It
 * is already tearing the call down locally, so pushing it an ending it caused
 * is noise. When the agent ends the call instead — `call_end` — nothing is
 * excluded, and the push is the only thing that tells the handset to stop
 * holding a line nobody is on any more.
 */
export function end(callId: string, exceptDeviceId?: string): CallSession | null {
  const call = store.finishCall(callId, 'ended');
  if (!call) return null;
  emit(call.id, { type: 'call.state', state: 'ended', callId: call.id });
  void pushCallEnded(call, 'ended', exceptDeviceId).catch(() => {});
  return call;
}

/* ------------------------------------------------------------ ring timeout -- */

/**
 * Mark calls that rang out as missed.
 *
 * Without this a call nobody touched stays 'ringing' forever, and the app has
 * no way to tell "still ringing" from "rang out an hour ago" when it reconnects
 * and asks for state.
 */
export function startRingTimeoutLoop(intervalMs = 5_000): () => void {
  const tick = () => {
    const cutoff = Date.now() - config.callRingSeconds * 1000;
    for (const call of store.listRingingCalls()) {
      if (call.createdAt > cutoff) continue;
      const missed = store.finishCall(call.id, 'missed');
      if (missed) {
        emit(missed.id, { type: 'call.state', state: 'missed', callId: missed.id });
        void pushCallEnded(missed, 'missed').catch(() => {});
      }
    }
  };

  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}

/* ------------------------------------------------------- conversation -- */

/**
 * A live call is a turn-taking loop, not a broadcast.
 *
 * The agent speaks, then waits. The phone records the reply, transcribes it (or
 * has the server do it), and posts it back as a turn. `listen` is what the
 * agent blocks on — the same shape as waiting on a long-running command, which
 * is the only model that fits an agent that thinks in turns rather than
 * streaming continuously.
 *
 * There is deliberately no interruption handling. Barging in on a half-spoken
 * sentence needs streaming both ways; this gets the conversation working first.
 */

function turnAudioUrl(callId: string, turnId: string): string {
  const base = config.publicUrl || `http://localhost:${config.port}`;
  return `${base}/api/calls/${callId}/turns/${turnId}/audio`;
}

/** Record something the agent said, and tell the phone to play it. */
export async function speak(
  callId: string,
  text: string,
  audioId: string | null,
): Promise<CallTurn | null> {
  const call = store.getCall(callId);
  if (!call || call.state !== 'answered') return null;

  const turn = store.addCallTurn({ id: randomUUID(), callId, speaker: 'agent', text, audioId });

  // Not the request's audio URL: that one is the opening line. Every turn after
  // it has its own recording, fetched with the device's own token — by this
  // point the app is in the call and authenticated, so the action-token trick
  // the first ring needs buys nothing here.
  const url = audioId ? turnAudioUrl(callId, turn.id) : null;

  emit(callId, { type: 'call.audio', url: url ?? '', text, seq: turn.seq });

  // The app may be backgrounded between turns — the screen can be off in a
  // pocket or a car mount. A push wakes it the same way the first ring did.
  const tokens = devices.pushTargets();
  if (tokens.length > 0) {
    const result = await push({
      tokens,
      ttlSeconds: 60,
      collapseKey: `call-turn-${callId}`,
      data: {
        type: 'call.turn',
        callId,
        seq: String(turn.seq),
        text,
        ...(url ? { audioUrl: url } : {}),
      },
    }).catch(() => ({ sent: 0, stale: [] as string[] }));
    devices.prunePushTokens(result.stale);
  }

  return turn;
}

/** Record what the human said. Returns null if the call is no longer live. */
export function hear(
  callId: string,
  text: string,
  stt: string,
  audioId: string | null,
): CallTurn | null {
  const call = store.getCall(callId);
  if (!call || call.state !== 'answered') return null;
  return store.addCallTurn({ id: randomUUID(), callId, speaker: 'human', text, audioId, stt });
}

/**
 * Block until the human says something after `afterSeq`, the call ends, or the
 * wait times out.
 *
 * Polling, not an event bus, for the same reason the pairing CLI polls: the
 * database is what actually knows, one row is being watched, and a beat of
 * latency is invisible against someone drawing breath to speak.
 */
export async function listen(
  callId: string,
  afterSeq: number,
  timeoutMs: number,
): Promise<{ state: 'heard'; turn: CallTurn } | { state: 'ended' | 'timeout' }> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const turn = store.turnAfter(callId, 'human', afterSeq);
    if (turn) return { state: 'heard', turn };

    const call = store.getCall(callId);
    if (!call || call.state !== 'answered') return { state: 'ended' };
    if (Date.now() >= deadline) return { state: 'timeout' };

    await new Promise((r) => setTimeout(r, LISTEN_POLL_MS));
  }
}

const LISTEN_POLL_MS = 400;

export const turns = store.listCallTurns;

export const get = store.getCall;
export const getForRequest = store.getCallForRequest;
export const listRecent = store.listRecentCalls;
