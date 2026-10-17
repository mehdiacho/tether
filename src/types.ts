/** Shared vocabulary. The status values are the contract with the agent. */

export type RequestKind =
  | 'notify' // fire-and-forget
  | 'ask' // question, optionally with choices
  | 'action' // "do this thing I can't"
  | 'secret' // OTP / short-lived code, human-released
  | 'call'; // spoken message, delivered at max priority and kept for replay

export type Priority = 'min' | 'low' | 'default' | 'high' | 'urgent';

/**
 * An agent must be able to tell these apart. Collapsing "you said no" into
 * "you never saw it" makes agents do the wrong thing, so they stay distinct.
 */
export type RequestStatus =
  | 'pending'
  | 'answered'
  | 'refused' // human explicitly declined
  | 'timed_out' // nobody responded before expiry
  | 'cancelled'; // agent withdrew it

export interface TetherRequest {
  id: string;
  kind: RequestKind;
  title: string;
  body: string;
  choices: string[] | null;
  /** Free-form agent context: task, session, repo. Shown to the human. */
  context: Record<string, unknown> | null;
  priority: Priority;
  status: RequestStatus;
  answer: string | null;
  /** Optional voice rendering of the body, if TTS was requested. */
  audioId: string | null;
  /** Single-purpose token: answers THIS request only. Safe to put in a
   *  notification payload, unlike a long-lived client token. */
  actionToken: string;
  agentName: string;
  /**
   * Who sent this, as an authenticated peer name — not the self-asserted
   * `agentName`. Empty for anything created before peers existed, or by a
   * legacy agent token that maps to no peer row.
   */
  fromPeer: string;
  /**
   * Who is being asked. **Empty means the human**, which is what every request
   * predating agent-to-agent was, so old rows keep working untouched.
   *
   * This one field is what turns `ask` into a general rendezvous: the state
   * machine never cared who answered, only that somebody did.
   */
  toPeer: string;
  /** Monotonic insertion order. Drives per-peer inbox cursors. */
  seq: number;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
}

/* ------------------------------------------------------------------ peers -- */

/**
 * What a peer is.
 *
 * `human` exists as a peer so that "ask Mehdi" and "ask Astra" are the same
 * call with a different address, rather than two subsystems. It is NOT a login:
 * the human peer holds no token and can never authenticate as itself. Anything
 * addressed to a human is answerable only over the client surface — the phone
 * and the web UI — and an agent that tries is refused.
 *
 * That asymmetry is the security boundary of the whole feature. If an agent
 * could answer a human-addressed request, a single prompt-injected agent would
 * be able to grant itself every approval Tether exists to gate.
 */
export type PeerKind = 'agent' | 'human';

export interface Peer {
  id: string;
  /** Address. Lowercase, stable, unique: 'claude-code', 'astra', 'mehdi'. */
  name: string;
  kind: PeerKind;
  /** Which tool this peer runs as, for display: 'claude-code', 'codex', ''. */
  tool: string;
  /** One line for the peer list, so an agent knows who it is talking to. */
  description: string;
  createdAt: number;
  lastSeenAt: number;
  revoked: boolean;
}

export interface ResolveResult {
  status: Exclude<RequestStatus, 'pending'>;
  answer: string | null;
}

/**
 * A recurring job the SERVER fires on its own, with no agent connected.
 *
 * This is the difference between "an agent can reach me" and "I get reminded
 * to check the seedlings at 7am". The latter must not depend on a Claude
 * session being alive, so the schedule lives in Tether's database and Tether's
 * own loop evaluates it.
 */
export interface Schedule {
  id: string;
  /** Standard 5-field cron: minute hour day-of-month month day-of-week. */
  cron: string;
  /** IANA zone the cron is interpreted in. The NAS runs UTC; you don't. */
  timezone: string;
  kind: Extract<RequestKind, 'notify' | 'ask' | 'call'>;
  title: string;
  body: string;
  choices: string[] | null;
  /** Render the body to speech when firing. */
  voice: boolean;
  priority: Priority;
  enabled: boolean;
  agentName: string;
  createdAt: number;
  lastRunAt: number | null;
  /** Minute-resolution guard so a restart inside the same minute can't double-fire. */
  lastFiredMinute: string | null;
}

/** Events pushed to connected clients over the WebSocket. */
export type ServerEvent =
  | { type: 'request.created'; request: TetherRequest }
  | { type: 'request.resolved'; request: TetherRequest }
  | { type: 'request.cancelled'; id: string }
  | { type: 'hello'; pending: TetherRequest[] };

/**
 * A paired device — in practice, a phone running the Tether app.
 *
 * Each device gets its OWN client token rather than sharing the one in
 * CLIENT_TOKENS. That is what makes "I lost my phone" a survivable event: the
 * device row is revoked and nothing else has to change. A shared token would
 * force rotating the secret on every other client too.
 */
export interface Device {
  id: string;
  name: string;
  platform: 'android' | 'ios' | 'web';
  /** FCM registration token. Null until the app reports one. */
  pushToken: string | null;
  /** This device's client token. Revoking the row revokes the token. */
  clientToken: string;
  createdAt: number;
  lastSeenAt: number;
  revoked: boolean;
}

/** Live phase of a call. The app and the server agree on these names. */
export type CallState =
  | 'ringing'
  | 'answered'
  | 'declined'
  | 'missed' // rang out with nobody picking up
  | 'ended';

/**
 * A call session, separate from the request that spawned it.
 *
 * A request is a durable question. A call is a transient, time-boxed audio
 * conversation about it — it can be missed, declined, or answered on one device
 * while three others stop ringing. Those lifecycles do not fit in one row.
 */
export interface CallSession {
  id: string;
  requestId: string;
  state: CallState;
  /** Device that picked up, once one has. */
  answeredBy: string | null;
  createdAt: number;
  answeredAt: number | null;
  endedAt: number | null;
}

/** One thing said on a call, by either side. */
export interface CallTurn {
  id: string;
  callId: string;
  /** Position in the conversation. Dense and gapless per call. */
  seq: number;
  speaker: 'agent' | 'human';
  text: string;
  /** The recording of this turn, when there is one. */
  audioId: string | null;
  /** Which transcriber produced `text`, for a human turn. */
  stt: string | null;
  createdAt: number;
}

/** Messages on the live call socket, server -> app. */
export type CallEvent =
  | { type: 'call.state'; state: CallState; callId: string }
  /** A segment of speech to play, as a URL the app fetches. */
  | { type: 'call.audio'; url: string; text: string; seq: number }
  /** No more audio is coming; the app may hang up once playback drains. */
  | { type: 'call.complete' };

/* ------------------------------------------------- sessions and agents -- */

/**
 * What a row in the session registry actually is.
 *
 * The distinction matters to the person reading the home page. A **session** is
 * something they started and can talk to: a Claude Code window, a terminal, a
 * cloud session. An **agent** is a subagent that some session spawned to do a
 * piece of work — it has its own transcript and its own lifetime, but nobody
 * addresses it directly, and it disappears when its task is done.
 *
 * Collapsing the two would make the home page lie: a session with four
 * subagents running would look like five things needing attention, and tapping
 * the wrong one would send a message nowhere.
 */
export type SessionKind = 'session' | 'agent';

/**
 * Where a session is and how a message reaches it.
 *
 * There is no supported third-party API for injecting a message into a running
 * Claude Code session, so every value here describes a *detour* around that:
 *
 * - `relay` — a long-lived Claude session on the same machine polls Tether and
 *   forwards messages over Claude Code's own local peer channel. The only way
 *   to reach a session on someone's actual desktop.
 * - `remote-control` — the session lives under a `claude remote-control`
 *   server. Tether cannot inject directly (the transport is Anthropic's, with
 *   no third-party API), so a relay session running *inside* that server does
 *   the same job.
 * - `none` — visible on the home page, not addressable. Correct for a session
 *   that registered itself but has no relay, and honest about it: the app grays
 *   out the composer instead of silently dropping what was typed.
 */
export type SessionTransport = 'relay' | 'remote-control' | 'none';

/**
 * Live phase, as reported by the session's own hooks.
 *
 * `waiting` is the load-bearing one — it means the session is BLOCKED on a
 * human, which is the thing worth ringing a phone about. `idle` means it
 * finished its turn and would take input but nothing is stuck. Conflating them
 * would make Tether either ring constantly or never.
 */
export type SessionState = 'working' | 'idle' | 'waiting' | 'ended';

export interface AgentSession {
  /** Tether's own id. Stable, and what the app addresses. */
  id: string;
  /** The id the tool knows it by: a Claude Code session_id or agent_id. */
  externalId: string;
  /** Tether id of the session that spawned this one. Null for a session. */
  parentId: string | null;
  kind: SessionKind;
  /** Subagent type, for `agent` rows: 'Explore', 'general-purpose', … */
  agentType: string | null;
  title: string;
  cwd: string;
  /** Which tool this is. Everything is 'claude-code' today. */
  tool: string;
  transport: SessionTransport;
  /** Name of the relay that can reach it. Empty when nothing can. */
  relay: string;
  /** How the relay addresses it — a peer name, not a Tether id. */
  address: string;
  state: SessionState;
  /** What it is blocked on, when `state` is 'waiting'. */
  waitingOn: string | null;
  startedAt: number;
  lastSeenAt: number;
  endedAt: number | null;
}

/** Who said a thing in a session's timeline. */
export type SessionRole = 'agent' | 'human' | 'system';

/**
 * Delivery state of a message typed on the phone.
 *
 * Only meaningful for `human` messages: those are the ones that have to travel
 * somewhere. An agent message is already where it came from, so its delivery is
 * the empty string rather than a fake 'delivered'.
 *
 * `queued` is also the relay's work queue — there is no separate outbox table,
 * because a message the human sent belongs in the transcript whether or not it
 * has landed yet, and merging two tables for display would be the only thing a
 * separate queue bought.
 */
export type MessageDelivery = '' | 'queued' | 'delivered' | 'failed' | 'expired';

export interface SessionMessage {
  id: string;
  sessionId: string;
  /** Position in the timeline. Dense and gapless per session. */
  seq: number;
  role: SessionRole;
  text: string;
  delivery: MessageDelivery;
  /** Why delivery failed, when it did. Shown under the message in the app. */
  error: string | null;
  deliveredAt: number | null;
  createdAt: number;
}
