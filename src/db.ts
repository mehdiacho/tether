/**
 * Persistence. Uses node:sqlite (built into Node 22.5+), so there is no native
 * module to compile and no ORM to reason about.
 *
 * Durability is the point: a pending request must survive the agent process
 * dying, so the agent can reconnect with its request id and collect the answer.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';
import type {
  AgentSession,
  CallSession,
  CallState,
  CallTurn,
  Device,
  MessageDelivery,
  Peer,
  PeerKind,
  SessionKind,
  SessionMessage,
  SessionRole,
  SessionState,
  SessionTransport,
  Priority,
  RequestKind,
  RequestStatus,
  Schedule,
  TetherRequest,
} from './types.ts';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS requests (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    choices     TEXT,
    context     TEXT,
    priority    TEXT NOT NULL DEFAULT 'default',
    status      TEXT NOT NULL DEFAULT 'pending',
    answer      TEXT,
    audio_id    TEXT,
    action_token TEXT NOT NULL DEFAULT '',
    agent_name  TEXT NOT NULL DEFAULT 'agent',
    -- Authenticated sender and addressee. An empty to_peer means the human,
    -- which is what every request predating agent-to-agent was.
    from_peer   TEXT NOT NULL DEFAULT '',
    to_peer     TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    resolved_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_requests_status  ON requests(status);
  CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_requests_inbox   ON requests(to_peer, status);

  -- Who may address whom.
  --
  -- A peer's identity comes from its TOKEN, never from a header it sends. The
  -- old X-Agent-Name was a display label that any client could set to any
  -- value; once agents can address each other, a self-asserted name is a
  -- spoofing primitive, so it stops being identity here.
  --
  -- The human peer deliberately has no token: nothing may authenticate AS the
  -- human. See PeerKind in types.ts for why that asymmetry is load-bearing.
  CREATE TABLE IF NOT EXISTS peers (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL DEFAULT 'agent',
    tool         TEXT NOT NULL DEFAULT '',
    token        TEXT UNIQUE,
    description  TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked      INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_peers_token ON peers(token);

  -- How far through its inbox each peer has read.
  --
  -- Day-one requirement, not an optimisation. Without it every doorbell poll
  -- re-delivers the same message, and an agent woken by a hook would answer the
  -- same question on every turn forever. The cursor is a rowid watermark
  -- because rowids are monotonic per insert; created_at is not unique enough,
  -- two requests can land in the same millisecond.
  CREATE TABLE IF NOT EXISTS peer_cursors (
    peer       TEXT NOT NULL,
    stream     TEXT NOT NULL DEFAULT 'inbox',
    last_seq   INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (peer, stream)
  );

  -- Audio blobs for voice messages. Kept out of the requests row so a large
  -- MP3 never bloats a hot query.
  --
  -- The keep flag marks a blob that is a RECORD rather than a cache. A notification's
  -- voice rendering is disposable — the text says the same thing. A call
  -- recording is not: it is the only artefact of the call, so it survives the
  -- pruner.
  CREATE TABLE IF NOT EXISTS audio (
    id         TEXT PRIMARY KEY,
    mime       TEXT NOT NULL,
    bytes      BLOB NOT NULL,
    keep       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  -- Paired devices. Each carries its OWN client token so a lost phone can be
  -- revoked on its own, without rotating the secret every other client uses.
  CREATE TABLE IF NOT EXISTS devices (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    platform     TEXT NOT NULL DEFAULT 'android',
    push_token   TEXT,
    client_token TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked      INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(client_token);

  -- Short-lived pairing codes. A phone should never have a long token typed
  -- into it; it claims one with a code that dies in minutes.
  CREATE TABLE IF NOT EXISTS pairing_codes (
    code       TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    claimed_at INTEGER,
    -- Which device claimed it. Lets the screen showing the QR say "paired"
    -- with the device's name instead of the operator guessing from a list.
    claimed_by TEXT
  );

  -- Call sessions. A request is a durable question; a call is a transient
  -- audio conversation about it, with its own ring/answer/end lifecycle.
  CREATE TABLE IF NOT EXISTS calls (
    id          TEXT PRIMARY KEY,
    request_id  TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'ringing',
    answered_by TEXT,
    created_at  INTEGER NOT NULL,
    answered_at INTEGER,
    ended_at    INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_calls_request ON calls(request_id);
  CREATE INDEX IF NOT EXISTS idx_calls_state   ON calls(state);

  -- What was actually said, in order, by both sides.
  --
  -- Separate from requests because a conversational call is not one message: it
  -- is a transcript, and the agent needs to read back its own previous turns to
  -- hold a thread. audio_id is nullable: the human's turn may arrive as text
  -- alone when the phone did the transcribing.
  CREATE TABLE IF NOT EXISTS call_turns (
    id         TEXT PRIMARY KEY,
    call_id    TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    speaker    TEXT NOT NULL,
    text       TEXT NOT NULL,
    audio_id   TEXT,
    stt        TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_call_turns_seq ON call_turns(call_id, seq);

  -- Recurring jobs the server fires with no agent attached.
  CREATE TABLE IF NOT EXISTS schedules (
    id                TEXT PRIMARY KEY,
    cron              TEXT NOT NULL,
    timezone          TEXT NOT NULL DEFAULT 'UTC',
    kind              TEXT NOT NULL,
    title             TEXT NOT NULL,
    body              TEXT NOT NULL,
    choices           TEXT,
    voice             INTEGER NOT NULL DEFAULT 0,
    priority          TEXT NOT NULL DEFAULT 'default',
    enabled           INTEGER NOT NULL DEFAULT 1,
    agent_name        TEXT NOT NULL DEFAULT 'agent',
    created_at        INTEGER NOT NULL,
    last_run_at       INTEGER,
    last_fired_minute TEXT
  );

  -- The session registry: what is running, and what it is doing.
  --
  -- Sessions and agents share one table because they share a shape (a title, a
  -- state, a transcript) and because the home page renders them as one tree.
  -- parent_id is what separates them: a row with a parent is a subagent, and
  -- nothing addresses it directly.
  --
  -- external_id is the tool's id, not ours. It is unique per tool rather than
  -- globally: two different tools may legitimately mint the same uuid, and the
  -- registry is meant to outlive being Claude Code specific.
  CREATE TABLE IF NOT EXISTS agent_sessions (
    id           TEXT PRIMARY KEY,
    external_id  TEXT NOT NULL,
    parent_id    TEXT,
    kind         TEXT NOT NULL DEFAULT 'session',
    agent_type   TEXT,
    title        TEXT NOT NULL DEFAULT '',
    cwd          TEXT NOT NULL DEFAULT '',
    tool         TEXT NOT NULL DEFAULT 'claude-code',
    transport    TEXT NOT NULL DEFAULT 'none',
    relay        TEXT NOT NULL DEFAULT '',
    address      TEXT NOT NULL DEFAULT '',
    state        TEXT NOT NULL DEFAULT 'idle',
    waiting_on   TEXT,
    started_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ended_at     INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_external ON agent_sessions(tool, external_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_parent ON agent_sessions(parent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_seen   ON agent_sessions(last_seen_at DESC);

  -- One session's timeline, both directions.
  --
  -- Messages the human sends live here too, with delivery = 'queued', rather
  -- than in a separate outbox. A message belongs in the transcript from the
  -- moment it is typed, whether or not it has landed yet; a separate queue
  -- would buy nothing except a merge on every read.
  CREATE TABLE IF NOT EXISTS session_messages (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    role         TEXT NOT NULL,
    text         TEXT NOT NULL,
    delivery     TEXT NOT NULL DEFAULT '',
    error        TEXT,
    delivered_at INTEGER,
    created_at   INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_session_msg_seq ON session_messages(session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_session_msg_queued ON session_messages(delivery, created_at);
`);


// Additive migrations: databases created by an earlier version still work.
{
  const cols = db.prepare(`PRAGMA table_info(requests)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'action_token')) {
    db.exec(`ALTER TABLE requests ADD COLUMN action_token TEXT NOT NULL DEFAULT ''`);
  }

  const audioCols = db.prepare(`PRAGMA table_info(audio)`).all() as { name: string }[];
  if (!audioCols.some((c) => c.name === 'keep')) {
    db.exec(`ALTER TABLE audio ADD COLUMN keep INTEGER NOT NULL DEFAULT 0`);
  }

  const pairCols = db.prepare(`PRAGMA table_info(pairing_codes)`).all() as { name: string }[];
  if (!pairCols.some((c) => c.name === 'claimed_by')) {
    db.exec(`ALTER TABLE pairing_codes ADD COLUMN claimed_by TEXT`);
  }

  // Agent-to-agent addressing. Defaulting to_peer to '' is what keeps every
  // existing row meaning "asked the human" without a data migration.
  if (!cols.some((c) => c.name === 'from_peer')) {
    db.exec(`ALTER TABLE requests ADD COLUMN from_peer TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.some((c) => c.name === 'to_peer')) {
    db.exec(`ALTER TABLE requests ADD COLUMN to_peer TEXT NOT NULL DEFAULT ''`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_requests_inbox ON requests(to_peer, status)`);
  }
}

/** SQLite gives us plain objects; map them into the shape the app uses. */
type Row = {
  id: string;
  kind: string;
  title: string;
  body: string;
  choices: string | null;
  context: string | null;
  priority: string;
  status: string;
  answer: string | null;
  audio_id: string | null;
  action_token: string;
  agent_name: string;
  from_peer: string;
  to_peer: string;
  seq: number;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
};

/**
 * Every request SELECT goes through this.
 *
 * `rowid AS seq` is the inbox cursor. SQLite hands it out monotonically per
 * insert, so "everything after seq N" is exact — which a created_at watermark
 * is not, since two requests can share a millisecond.
 */
const REQ_COLS = `rowid AS seq, *`;

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function rowToRequest(r: Row): TetherRequest {
  return {
    id: r.id,
    kind: r.kind as RequestKind,
    title: r.title,
    body: r.body,
    choices: parseJson<string[]>(r.choices),
    context: parseJson<Record<string, unknown>>(r.context),
    priority: r.priority as Priority,
    status: r.status as RequestStatus,
    answer: r.answer,
    audioId: r.audio_id,
    actionToken: r.action_token,
    agentName: r.agent_name,
    fromPeer: r.from_peer ?? '',
    toPeer: r.to_peer ?? '',
    seq: r.seq,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    resolvedAt: r.resolved_at,
  };
}

const stmts = {
  insert: db.prepare(`
    INSERT INTO requests
      (id, kind, title, body, choices, context, priority, status, audio_id, action_token, agent_name, from_peer, to_peer, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `),
  byId: db.prepare(`SELECT ${REQ_COLS} FROM requests WHERE id = ?`),
  // The human's pending list. Scoped to to_peer = '' so agent-to-agent traffic
  // never reaches the phone: an agent asking another agent a question is not a
  // notification, and fanning it out would make Tether ring all day.
  pending: db.prepare(`
    SELECT ${REQ_COLS} FROM requests
     WHERE status = 'pending' AND to_peer = '' ORDER BY created_at DESC
  `),
  recent: db.prepare(
    `SELECT ${REQ_COLS} FROM requests WHERE to_peer = '' ORDER BY created_at DESC LIMIT ?`,
  ),
  resolve: db.prepare(`
    UPDATE requests SET status = ?, answer = ?, resolved_at = ?
    WHERE id = ? AND status = 'pending'
  `),
  expireDue: db.prepare(`
    UPDATE requests SET status = 'timed_out', resolved_at = ?
    WHERE status = 'pending' AND expires_at <= ?
  `),
  dueIds: db.prepare(`
    SELECT id FROM requests WHERE status = 'pending' AND expires_at <= ?
  `),
  byActionToken: db.prepare(
    `SELECT ${REQ_COLS} FROM requests WHERE id = ? AND action_token = ?`,
  ),
  // One peer's unread inbox: addressed to it, still pending, after its cursor.
  inboxAfter: db.prepare(`
    SELECT ${REQ_COLS} FROM requests
     WHERE to_peer = ? AND status = 'pending' AND rowid > ?
     ORDER BY rowid ASC LIMIT ?
  `),
  putAudio: db.prepare(
    `INSERT INTO audio (id, mime, bytes, keep, created_at) VALUES (?, ?, ?, ?, ?)`,
  ),
  getAudio: db.prepare(`SELECT mime, bytes FROM audio WHERE id = ?`),
  pruneAudio: db.prepare(`DELETE FROM audio WHERE created_at < ? AND keep = 0`),

  insertSchedule: db.prepare(`
    INSERT INTO schedules
      (id, cron, timezone, kind, title, body, choices, voice, priority, enabled, agent_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `),
  allSchedules: db.prepare(`SELECT * FROM schedules ORDER BY created_at`),
  enabledSchedules: db.prepare(`SELECT * FROM schedules WHERE enabled = 1`),
  scheduleById: db.prepare(`SELECT * FROM schedules WHERE id = ?`),
  deleteSchedule: db.prepare(`DELETE FROM schedules WHERE id = ?`),
  setScheduleEnabled: db.prepare(`UPDATE schedules SET enabled = ? WHERE id = ?`),
  markScheduleFired: db.prepare(
    `UPDATE schedules SET last_run_at = ?, last_fired_minute = ? WHERE id = ?`,
  ),
};

export interface InsertArgs {
  id: string;
  kind: RequestKind;
  title: string;
  body: string;
  choices: string[] | null;
  context: Record<string, unknown> | null;
  priority: Priority;
  audioId: string | null;
  actionToken: string;
  agentName: string;
  fromPeer: string;
  /** Empty addresses the human. */
  toPeer: string;
  createdAt: number;
  expiresAt: number;
}

export function insertRequest(a: InsertArgs): TetherRequest {
  stmts.insert.run(
    a.id,
    a.kind,
    a.title,
    a.body,
    a.choices ? JSON.stringify(a.choices) : null,
    a.context ? JSON.stringify(a.context) : null,
    a.priority,
    a.audioId,
    a.actionToken,
    a.agentName,
    a.fromPeer,
    a.toPeer,
    a.createdAt,
    a.expiresAt,
  );
  return getRequest(a.id)!;
}

export function getRequest(id: string): TetherRequest | null {
  const row = stmts.byId.get(id) as Row | undefined;
  return row ? rowToRequest(row) : null;
}

export function listPending(): TetherRequest[] {
  return (stmts.pending.all() as Row[]).map(rowToRequest);
}

export function listRecent(limit = 50): TetherRequest[] {
  return (stmts.recent.all(limit) as Row[]).map(rowToRequest);
}

/**
 * Resolve a pending request. Returns null if it was already resolved —
 * the UPDATE is guarded on status='pending', so two clients racing to answer
 * cannot both win.
 */
export function resolveRequest(
  id: string,
  status: Exclude<RequestStatus, 'pending'>,
  answer: string | null,
): TetherRequest | null {
  const res = stmts.resolve.run(status, answer, Date.now(), id);
  if (res.changes === 0) return null;
  return getRequest(id);
}

/** Sweep expired requests. Returns the ids that just timed out. */
export function expireDue(): string[] {
  const now = Date.now();
  const ids = (stmts.dueIds.all(now) as { id: string }[]).map((r) => r.id);
  if (ids.length > 0) stmts.expireDue.run(now, now);
  return ids;
}

/**
 * Store an audio blob. `keep` marks it as a record rather than a cache — used
 * for call recordings, which are the only artefact of the call and so must
 * outlive the 48h pruner.
 */
export function putAudio(id: string, mime: string, bytes: Uint8Array, keep = false): void {
  stmts.putAudio.run(id, mime, bytes, keep ? 1 : 0, Date.now());
}

export function getAudio(id: string): { mime: string; bytes: Uint8Array } | null {
  const row = stmts.getAudio.get(id) as { mime: string; bytes: Uint8Array } | undefined;
  return row ?? null;
}

/** Audio is a cache, not a record. Drop anything older than the cutoff. */
export function pruneAudio(olderThanMs: number): void {
  stmts.pruneAudio.run(Date.now() - olderThanMs);
}

/**
 * Look a request up by its id AND single-purpose action token. Used by the
 * tappable notification buttons, so a leaked notification payload can only ever
 * answer the one request it belongs to.
 */
export function getByActionToken(id: string, token: string): TetherRequest | null {
  if (!token) return null;
  const row = stmts.byActionToken.get(id, token) as Row | undefined;
  return row ? rowToRequest(row) : null;
}

/**
 * A peer's unread, still-pending inbox, oldest first.
 *
 * Only pending rows: a question someone else already answered, or that timed
 * out, is not work. The cursor still has to advance past it, which is why
 * `advanceCursor` takes the high-water seq the caller actually saw rather than
 * counting rows.
 */
export function inboxAfter(peer: string, afterSeq: number, limit = 20): TetherRequest[] {
  return (stmts.inboxAfter.all(peer, afterSeq, limit) as Row[]).map(rowToRequest);
}

/* ------------------------------------------------------------------ peers -- */

type PeerRow = {
  id: string;
  name: string;
  kind: string;
  tool: string;
  token: string | null;
  description: string;
  created_at: number;
  last_seen_at: number;
  revoked: number;
};

function rowToPeer(r: PeerRow): Peer {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as PeerKind,
    tool: r.tool,
    description: r.description,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    revoked: r.revoked === 1,
  };
}

const peerStmts = {
  insert: db.prepare(`
    INSERT INTO peers (id, name, kind, tool, token, description, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  byName: db.prepare(`SELECT * FROM peers WHERE name = ?`),
  byToken: db.prepare(`SELECT * FROM peers WHERE token = ? AND revoked = 0`),
  all: db.prepare(`SELECT * FROM peers WHERE revoked = 0 ORDER BY kind, name`),
  touch: db.prepare(`UPDATE peers SET last_seen_at = ? WHERE id = ?`),
  revoke: db.prepare(`UPDATE peers SET revoked = 1, token = NULL WHERE name = ?`),
  cursorGet: db.prepare(`SELECT last_seq FROM peer_cursors WHERE peer = ? AND stream = ?`),
  // Guarded with MAX so an out-of-order or replayed advance can never rewind a
  // cursor and re-deliver work the peer already handled.
  cursorSet: db.prepare(`
    INSERT INTO peer_cursors (peer, stream, last_seq, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(peer, stream) DO UPDATE
      SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at
  `),
};

export interface InsertPeerArgs {
  id: string;
  name: string;
  kind: PeerKind;
  tool: string;
  /** Null for a human peer — nothing may authenticate as the human. */
  token: string | null;
  description: string;
}

export function insertPeer(a: InsertPeerArgs): Peer {
  const now = Date.now();
  peerStmts.insert.run(a.id, a.name, a.kind, a.tool, a.token, a.description, now, now);
  return getPeer(a.name)!;
}

export function getPeer(name: string): Peer | null {
  const r = peerStmts.byName.get(name) as PeerRow | undefined;
  return r ? rowToPeer(r) : null;
}

/** Identity, derived from the credential rather than asserted by the caller. */
export function getPeerByToken(token: string): Peer | null {
  if (!token) return null;
  const r = peerStmts.byToken.get(token) as PeerRow | undefined;
  return r ? rowToPeer(r) : null;
}

export function listPeers(): Peer[] {
  return (peerStmts.all.all() as PeerRow[]).map(rowToPeer);
}

export function touchPeer(id: string): void {
  peerStmts.touch.run(Date.now(), id);
}

export function revokePeer(name: string): boolean {
  return peerStmts.revoke.run(name).changes > 0;
}

export function getCursor(peer: string, stream = 'inbox'): number {
  const r = peerStmts.cursorGet.get(peer, stream) as { last_seq: number } | undefined;
  return r?.last_seq ?? 0;
}

export function advanceCursor(peer: string, seq: number, stream = 'inbox'): void {
  peerStmts.cursorSet.run(peer, stream, seq, Date.now());
}

/* -------------------------------------------------------------- schedules -- */

type ScheduleRow = {
  id: string;
  cron: string;
  timezone: string;
  kind: string;
  title: string;
  body: string;
  choices: string | null;
  voice: number;
  priority: string;
  enabled: number;
  agent_name: string;
  created_at: number;
  last_run_at: number | null;
  last_fired_minute: string | null;
};

function rowToSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    cron: r.cron,
    timezone: r.timezone,
    kind: r.kind as Schedule['kind'],
    title: r.title,
    body: r.body,
    choices: parseJson<string[]>(r.choices),
    voice: r.voice === 1,
    priority: r.priority as Priority,
    enabled: r.enabled === 1,
    agentName: r.agent_name,
    createdAt: r.created_at,
    lastRunAt: r.last_run_at,
    lastFiredMinute: r.last_fired_minute,
  };
}

export interface InsertScheduleArgs {
  id: string;
  cron: string;
  timezone: string;
  kind: Schedule['kind'];
  title: string;
  body: string;
  choices: string[] | null;
  voice: boolean;
  priority: Priority;
  agentName: string;
}

export function insertSchedule(a: InsertScheduleArgs): Schedule {
  stmts.insertSchedule.run(
    a.id,
    a.cron,
    a.timezone,
    a.kind,
    a.title,
    a.body,
    a.choices ? JSON.stringify(a.choices) : null,
    a.voice ? 1 : 0,
    a.priority,
    a.agentName,
    Date.now(),
  );
  return getSchedule(a.id)!;
}

export function getSchedule(id: string): Schedule | null {
  const row = stmts.scheduleById.get(id) as ScheduleRow | undefined;
  return row ? rowToSchedule(row) : null;
}

export function listSchedules(): Schedule[] {
  return (stmts.allSchedules.all() as ScheduleRow[]).map(rowToSchedule);
}

export function listEnabledSchedules(): Schedule[] {
  return (stmts.enabledSchedules.all() as ScheduleRow[]).map(rowToSchedule);
}

export function deleteSchedule(id: string): boolean {
  return stmts.deleteSchedule.run(id).changes > 0;
}

export function setScheduleEnabled(id: string, enabled: boolean): boolean {
  return stmts.setScheduleEnabled.run(enabled ? 1 : 0, id).changes > 0;
}

/**
 * Record that a schedule fired in a given wall-clock minute. The minute key is
 * what makes firing idempotent: the loop ticks more often than once a minute,
 * and a restart must not replay a job that already ran.
 */
export function markScheduleFired(id: string, minuteKey: string): void {
  stmts.markScheduleFired.run(Date.now(), minuteKey, id);
}

/* ------------------------------------------------------------------ devices -- */

type DeviceRow = {
  id: string;
  name: string;
  platform: string;
  push_token: string | null;
  client_token: string;
  created_at: number;
  last_seen_at: number;
  revoked: number;
};

function rowToDevice(r: DeviceRow): Device {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform as Device['platform'],
    pushToken: r.push_token,
    clientToken: r.client_token,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    revoked: r.revoked === 1,
  };
}

const deviceStmts = {
  insert: db.prepare(
    `INSERT INTO devices (id, name, platform, push_token, client_token, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ),
  byId: db.prepare(`SELECT * FROM devices WHERE id = ?`),
  byClientToken: db.prepare(`SELECT * FROM devices WHERE client_token = ? AND revoked = 0`),
  all: db.prepare(`SELECT * FROM devices ORDER BY created_at DESC`),
  activePushTokens: db.prepare(
    `SELECT push_token FROM devices WHERE revoked = 0 AND push_token IS NOT NULL AND push_token <> ''`,
  ),
  activePushTokensExcept: db.prepare(
    `SELECT push_token FROM devices
      WHERE revoked = 0 AND push_token IS NOT NULL AND push_token <> '' AND id <> ?`,
  ),
  setPushToken: db.prepare(`UPDATE devices SET push_token = ?, last_seen_at = ? WHERE id = ?`),
  touch: db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`),
  revoke: db.prepare(`UPDATE devices SET revoked = 1, push_token = NULL WHERE id = ?`),
  clearPushToken: db.prepare(`UPDATE devices SET push_token = NULL WHERE push_token = ?`),
};

export interface InsertDeviceArgs {
  id: string;
  name: string;
  platform: Device['platform'];
  pushToken: string | null;
  clientToken: string;
}

export function insertDevice(a: InsertDeviceArgs): Device {
  const now = Date.now();
  deviceStmts.insert.run(a.id, a.name, a.platform, a.pushToken, a.clientToken, now, now);
  return getDevice(a.id)!;
}

export function getDevice(id: string): Device | null {
  const r = deviceStmts.byId.get(id) as DeviceRow | undefined;
  return r ? rowToDevice(r) : null;
}

export function getDeviceByClientToken(token: string): Device | null {
  const r = deviceStmts.byClientToken.get(token) as DeviceRow | undefined;
  return r ? rowToDevice(r) : null;
}

export function listDevices(): Device[] {
  return (deviceStmts.all.all() as DeviceRow[]).map(rowToDevice);
}

/**
 * Every push target worth sending to. Revoked and token-less rows excluded.
 *
 * `exceptDeviceId` leaves one device out. That matters for the push that tells
 * everyone a call is over: the device that just answered must not receive it,
 * or it dismisses the call it is in the middle of taking.
 */
export function activePushTokens(exceptDeviceId?: string): string[] {
  const rows = exceptDeviceId
    ? deviceStmts.activePushTokensExcept.all(exceptDeviceId)
    : deviceStmts.activePushTokens.all();
  return (rows as { push_token: string }[]).map((r) => r.push_token);
}

export function setDevicePushToken(id: string, pushToken: string): void {
  deviceStmts.setPushToken.run(pushToken, Date.now(), id);
}

export function touchDevice(id: string): void {
  deviceStmts.touch.run(Date.now(), id);
}

export function revokeDevice(id: string): boolean {
  return deviceStmts.revoke.run(id).changes > 0;
}

/**
 * Forget a push token FCM told us is dead. The device row survives — the app
 * may simply have been reinstalled, and it will register a fresh token when it
 * next starts.
 */
export function clearPushToken(pushToken: string): void {
  deviceStmts.clearPushToken.run(pushToken);
}

/* ------------------------------------------------------------ pairing codes -- */

const pairStmts = {
  insert: db.prepare(
    `INSERT INTO pairing_codes (code, created_at, expires_at) VALUES (?, ?, ?)`,
  ),
  get: db.prepare(`SELECT * FROM pairing_codes WHERE code = ?`),
  claim: db.prepare(
    `UPDATE pairing_codes SET claimed_at = ?
     WHERE code = ? AND claimed_at IS NULL AND expires_at > ?`,
  ),
  attribute: db.prepare(`UPDATE pairing_codes SET claimed_by = ? WHERE code = ?`),
  purge: db.prepare(`DELETE FROM pairing_codes WHERE expires_at < ?`),
};

/**
 * How long an expired code sticks around before the purge takes it.
 *
 * A code is unusable the moment it expires, but the screen that showed it is
 * still polling for a result. Keeping the spent row briefly is what lets that
 * screen say "paired" rather than "unknown code" when the claim lands in the
 * last second.
 */
const PAIRING_RETENTION_MS = 15 * 60 * 1000;

export interface PairingCodeRow {
  code: string;
  created_at: number;
  expires_at: number;
  claimed_at: number | null;
  claimed_by: string | null;
}

export function getPairingCode(code: string): PairingCodeRow | null {
  return (pairStmts.get.get(code) as PairingCodeRow | undefined) ?? null;
}

/** Record which device won the race for a code, for the benefit of the UI. */
export function setPairingClaimedBy(code: string, deviceId: string): void {
  pairStmts.attribute.run(deviceId, code);
}

export function insertPairingCode(code: string, ttlMs: number): { code: string; expiresAt: number } {
  const now = Date.now();
  const expiresAt = now + ttlMs;
  pairStmts.insert.run(code, now, expiresAt);
  return { code, expiresAt };
}

/**
 * Consume a pairing code. Returns false if it never existed, already expired,
 * or was already used — the UPDATE is guarded, so two phones racing on the same
 * code produce exactly one winner.
 */
export function claimPairingCode(code: string): boolean {
  return pairStmts.claim.run(Date.now(), code, Date.now()).changes > 0;
}

export function purgePairingCodes(): void {
  pairStmts.purge.run(Date.now() - PAIRING_RETENTION_MS);
}

/* -------------------------------------------------------------------- calls -- */

type CallRow = {
  id: string;
  request_id: string;
  state: string;
  answered_by: string | null;
  created_at: number;
  answered_at: number | null;
  ended_at: number | null;
};

function rowToCall(r: CallRow): CallSession {
  return {
    id: r.id,
    requestId: r.request_id,
    state: r.state as CallState,
    answeredBy: r.answered_by,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
    endedAt: r.ended_at,
  };
}

const callStmts = {
  insert: db.prepare(
    `INSERT INTO calls (id, request_id, state, created_at) VALUES (?, ?, 'ringing', ?)`,
  ),
  byId: db.prepare(`SELECT * FROM calls WHERE id = ?`),
  byRequest: db.prepare(`SELECT * FROM calls WHERE request_id = ? ORDER BY created_at DESC`),
  recent: db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT ?`),
  ringing: db.prepare(`SELECT * FROM calls WHERE state = 'ringing'`),
  // Guarded: only a call that is still ringing can be answered, so the first
  // device to pick up wins and the others get a 409 rather than a second answer.
  answer: db.prepare(
    `UPDATE calls SET state = 'answered', answered_by = ?, answered_at = ?
     WHERE id = ? AND state = 'ringing'`,
  ),
  finish: db.prepare(
    `UPDATE calls SET state = ?, ended_at = ? WHERE id = ? AND state IN ('ringing','answered')`,
  ),
};

export function insertCall(id: string, requestId: string): CallSession {
  callStmts.insert.run(id, requestId, Date.now());
  return getCall(id)!;
}

export function getCall(id: string): CallSession | null {
  const r = callStmts.byId.get(id) as CallRow | undefined;
  return r ? rowToCall(r) : null;
}

export function getCallForRequest(requestId: string): CallSession | null {
  const r = callStmts.byRequest.get(requestId) as CallRow | undefined;
  return r ? rowToCall(r) : null;
}

export function listRecentCalls(limit = 50): CallSession[] {
  return (callStmts.recent.all(limit) as CallRow[]).map(rowToCall);
}

export function listRingingCalls(): CallSession[] {
  return (callStmts.ringing.all() as CallRow[]).map(rowToCall);
}

/** Returns the session only if THIS attempt was the one that answered it. */
export function answerCall(id: string, deviceId: string): CallSession | null {
  const changed = callStmts.answer.run(deviceId, Date.now(), id).changes > 0;
  return changed ? getCall(id) : null;
}

export function finishCall(id: string, state: Extract<CallState, 'declined' | 'missed' | 'ended'>): CallSession | null {
  const changed = callStmts.finish.run(state, Date.now(), id).changes > 0;
  return changed ? getCall(id) : null;
}

/* ----------------------------------------------------------- call turns -- */

const turnStmts = {
  insert: db.prepare(
    `INSERT INTO call_turns (id, call_id, seq, speaker, text, audio_id, stt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  forCall: db.prepare(`SELECT * FROM call_turns WHERE call_id = ? ORDER BY seq ASC`),
  nextSeq: db.prepare(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM call_turns WHERE call_id = ?`,
  ),
  latestFrom: db.prepare(
    `SELECT * FROM call_turns WHERE call_id = ? AND speaker = ? AND seq > ?
      ORDER BY seq ASC LIMIT 1`,
  ),
};

type CallTurnRow = {
  id: string;
  call_id: string;
  seq: number;
  speaker: string;
  text: string;
  audio_id: string | null;
  stt: string | null;
  created_at: number;
};

function rowToTurn(r: CallTurnRow): CallTurn {
  return {
    id: r.id,
    callId: r.call_id,
    seq: r.seq,
    speaker: r.speaker === 'human' ? 'human' : 'agent',
    text: r.text,
    audioId: r.audio_id,
    stt: r.stt,
    createdAt: r.created_at,
  };
}

export interface AddTurnArgs {
  id: string;
  callId: string;
  speaker: CallTurn['speaker'];
  text: string;
  audioId?: string | null;
  stt?: string | null;
}

/**
 * Append a turn. The sequence number is assigned here, under the same lock as
 * the insert, so two turns arriving together cannot claim the same position.
 */
export function addCallTurn(args: AddTurnArgs): CallTurn {
  const now = Date.now();
  const seq = (turnStmts.nextSeq.get(args.callId) as { next: number }).next;
  turnStmts.insert.run(
    args.id,
    args.callId,
    seq,
    args.speaker,
    args.text,
    args.audioId ?? null,
    args.stt ?? null,
    now,
  );
  return {
    id: args.id,
    callId: args.callId,
    seq,
    speaker: args.speaker,
    text: args.text,
    audioId: args.audioId ?? null,
    stt: args.stt ?? null,
    createdAt: now,
  };
}

export function listCallTurns(callId: string): CallTurn[] {
  return (turnStmts.forCall.all(callId) as CallTurnRow[]).map(rowToTurn);
}

/** The first turn from `speaker` after `afterSeq`, or null. Drives listening. */
export function turnAfter(
  callId: string,
  speaker: CallTurn['speaker'],
  afterSeq: number,
): CallTurn | null {
  const row = turnStmts.latestFrom.get(callId, speaker, afterSeq) as CallTurnRow | undefined;
  return row ? rowToTurn(row) : null;
}

/* ---------------------------------------------------- sessions/agents -- */

type SessionRow = {
  id: string;
  external_id: string;
  parent_id: string | null;
  kind: string;
  agent_type: string | null;
  title: string;
  cwd: string;
  tool: string;
  transport: string;
  relay: string;
  address: string;
  state: string;
  waiting_on: string | null;
  started_at: number;
  last_seen_at: number;
  ended_at: number | null;
};

function rowToSession(r: SessionRow): AgentSession {
  return {
    id: r.id,
    externalId: r.external_id,
    parentId: r.parent_id,
    kind: r.kind as SessionKind,
    agentType: r.agent_type,
    title: r.title,
    cwd: r.cwd,
    tool: r.tool,
    transport: r.transport as SessionTransport,
    relay: r.relay,
    address: r.address,
    state: r.state as SessionState,
    waitingOn: r.waiting_on,
    startedAt: r.started_at,
    lastSeenAt: r.last_seen_at,
    endedAt: r.ended_at,
  };
}

const sessionStmts = {
  insert: db.prepare(`
    INSERT INTO agent_sessions
      (id, external_id, parent_id, kind, agent_type, title, cwd, tool,
       transport, relay, address, state, started_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  // Re-registration keeps identity and history, refreshes the reachable bits.
  // A session that restarts under a new relay must not become a second row on
  // the home page, and must not keep advertising the relay that died with it.
  update: db.prepare(`
    UPDATE agent_sessions
       SET title = ?, cwd = ?, transport = ?, relay = ?, address = ?,
           parent_id = ?, agent_type = ?, kind = ?,
           state = CASE WHEN state = 'ended' THEN 'idle' ELSE state END,
           ended_at = CASE WHEN state = 'ended' THEN NULL ELSE ended_at END,
           last_seen_at = ?
     WHERE id = ?
  `),
  byExternal: db.prepare(`SELECT * FROM agent_sessions WHERE tool = ? AND external_id = ?`),
  byId: db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`),
  list: db.prepare(`
    SELECT * FROM agent_sessions
     WHERE (? = 1 OR state != 'ended')
     ORDER BY last_seen_at DESC LIMIT ?
  `),
  setState: db.prepare(`
    UPDATE agent_sessions
       SET state = ?, waiting_on = ?, last_seen_at = ?,
           ended_at = CASE WHEN ? = 'ended' THEN ? ELSE NULL END
     WHERE id = ?
  `),
  setTitle: db.prepare(`UPDATE agent_sessions SET title = ?, last_seen_at = ? WHERE id = ?`),
  touch: db.prepare(`UPDATE agent_sessions SET last_seen_at = ? WHERE id = ?`),
  // Ending a parent ends the subagents it spawned. They cannot outlive it —
  // their transcript lives inside its process — and leaving them 'working'
  // would strand rows on the home page that never go away.
  endChildren: db.prepare(`
    UPDATE agent_sessions SET state = 'ended', ended_at = ?
     WHERE parent_id = ? AND state != 'ended'
  `),
  prune: db.prepare(`DELETE FROM agent_sessions WHERE state = 'ended' AND ended_at < ?`),
};

export interface UpsertSessionArgs {
  id: string;
  externalId: string;
  parentId: string | null;
  kind: SessionKind;
  agentType: string | null;
  title: string;
  cwd: string;
  tool: string;
  transport: SessionTransport;
  relay: string;
  address: string;
}

/** Register, or re-register. Returns the row either way. */
export function upsertSession(a: UpsertSessionArgs): AgentSession {
  const now = Date.now();
  const existing = sessionStmts.byExternal.get(a.tool, a.externalId) as SessionRow | undefined;
  if (existing) {
    sessionStmts.update.run(
      a.title || existing.title,
      a.cwd || existing.cwd,
      a.transport,
      a.relay,
      a.address,
      a.parentId,
      a.agentType,
      a.kind,
      now,
      existing.id,
    );
    return rowToSession(sessionStmts.byId.get(existing.id) as SessionRow);
  }
  sessionStmts.insert.run(
    a.id,
    a.externalId,
    a.parentId,
    a.kind,
    a.agentType,
    a.title,
    a.cwd,
    a.tool,
    a.transport,
    a.relay,
    a.address,
    'working',
    now,
    now,
  );
  return rowToSession(sessionStmts.byId.get(a.id) as SessionRow);
}

export function getSession(id: string): AgentSession | null {
  const r = sessionStmts.byId.get(id) as SessionRow | undefined;
  return r ? rowToSession(r) : null;
}

export function getSessionByExternal(tool: string, externalId: string): AgentSession | null {
  const r = sessionStmts.byExternal.get(tool, externalId) as SessionRow | undefined;
  return r ? rowToSession(r) : null;
}

export function listSessions(includeEnded = false, limit = 200): AgentSession[] {
  return (sessionStmts.list.all(includeEnded ? 1 : 0, limit) as SessionRow[]).map(rowToSession);
}

export function setSessionState(
  id: string,
  state: SessionState,
  waitingOn: string | null,
): AgentSession | null {
  const now = Date.now();
  sessionStmts.setState.run(state, waitingOn, now, state, now, id);
  if (state === 'ended') sessionStmts.endChildren.run(now, id);
  return getSession(id);
}

export function setSessionTitle(id: string, title: string): void {
  sessionStmts.setTitle.run(title, Date.now(), id);
}

export function touchSession(id: string): void {
  sessionStmts.touch.run(Date.now(), id);
}

/** Drop long-dead sessions so the registry does not grow without bound. */
export function pruneSessions(olderThanMs: number): void {
  sessionStmts.prune.run(Date.now() - olderThanMs);
}

/* --------------------------------------------------- session messages -- */

type MessageRow = {
  id: string;
  session_id: string;
  seq: number;
  role: string;
  text: string;
  delivery: string;
  error: string | null;
  delivered_at: number | null;
  created_at: number;
};

function rowToMessage(r: MessageRow): SessionMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    role: r.role as SessionRole,
    text: r.text,
    delivery: r.delivery as MessageDelivery,
    error: r.error,
    deliveredAt: r.delivered_at,
    createdAt: r.created_at,
  };
}

const msgStmts = {
  nextSeq: db.prepare(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_messages WHERE session_id = ?`,
  ),
  insert: db.prepare(`
    INSERT INTO session_messages (id, session_id, seq, role, text, delivery, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  byId: db.prepare(`SELECT * FROM session_messages WHERE id = ?`),
  forSession: db.prepare(`
    SELECT * FROM session_messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?
  `),
  tail: db.prepare(`
    SELECT * FROM session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1
  `),
  // The relay's work queue. Joined to sessions so a relay only ever sees the
  // messages it can actually deliver — one machine's relay must not be handed
  // another machine's traffic just because it polled first.
  queued: db.prepare(`
    SELECT m.* FROM session_messages m
      JOIN agent_sessions s ON s.id = m.session_id
     WHERE m.delivery = 'queued' AND s.relay = ? AND s.state != 'ended'
     ORDER BY m.created_at ASC LIMIT ?
  `),
  settle: db.prepare(`
    UPDATE session_messages SET delivery = ?, error = ?, delivered_at = ?
     WHERE id = ? AND delivery = 'queued'
  `),
  expire: db.prepare(`
    UPDATE session_messages SET delivery = 'expired', delivered_at = ?
     WHERE delivery = 'queued' AND created_at < ?
  `),
};

export interface AddMessageArgs {
  id: string;
  sessionId: string;
  role: SessionRole;
  text: string;
  delivery: MessageDelivery;
}

export function addSessionMessage(a: AddMessageArgs): SessionMessage {
  const { seq } = msgStmts.nextSeq.get(a.sessionId) as { seq: number };
  msgStmts.insert.run(a.id, a.sessionId, seq, a.role, a.text, a.delivery, Date.now());
  touchSession(a.sessionId);
  return rowToMessage(msgStmts.byId.get(a.id) as MessageRow);
}

export function listSessionMessages(sessionId: string, limit = 200): SessionMessage[] {
  return (msgStmts.forSession.all(sessionId, limit) as MessageRow[]).map(rowToMessage);
}

export function lastSessionMessage(sessionId: string): SessionMessage | null {
  const r = msgStmts.tail.get(sessionId) as MessageRow | undefined;
  return r ? rowToMessage(r) : null;
}

export function queuedForRelay(relay: string, limit = 20): SessionMessage[] {
  return (msgStmts.queued.all(relay, limit) as MessageRow[]).map(rowToMessage);
}

/** Mark a queued message delivered or failed. No-op if it already settled. */
export function settleMessage(
  id: string,
  delivery: Extract<MessageDelivery, 'delivered' | 'failed'>,
  error: string | null,
): SessionMessage | null {
  msgStmts.settle.run(delivery, error, Date.now(), id);
  const r = msgStmts.byId.get(id) as MessageRow | undefined;
  return r ? rowToMessage(r) : null;
}

/**
 * Give up on messages nothing ever collected.
 *
 * A message that has sat in the queue for an hour will not be useful when it
 * finally lands — the session has moved on, or died along with the relay that
 * should have carried it. Landing it late is worse than not landing it, so it
 * expires visibly instead of lurking.
 */
export function expireQueuedMessages(olderThanMs: number): void {
  msgStmts.expire.run(Date.now(), Date.now() - olderThanMs);
}
