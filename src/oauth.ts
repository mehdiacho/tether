/**
 * OAuth 2.1 for the MCP endpoint, so Tether can be added as a claude.ai
 * custom connector.
 *
 * claude.ai connectors authenticate with OAuth (dynamic client registration +
 * PKCE), not with a static bearer header, so a LAN token in `.mcp.json` is not
 * an option for project threads running in the cloud. This module is the
 * smallest authorization server that satisfies the MCP authorization spec:
 *
 *   - RFC 9728 protected-resource metadata, advertised on every 401 from /mcp
 *   - RFC 8414 authorization-server metadata
 *   - RFC 7591 dynamic client registration (public clients only)
 *   - authorization code + PKCE S256, refresh tokens that rotate on use
 *
 * Consent is the part that matters, and it reuses Tether itself: the authorize
 * page raises an `ask` to the human — "Connect Claude to Tether?" — and only an
 * Allow from the phone or web UI issues a code. Nothing an agent holds can
 * answer that ask (see `requests.resolve`), so a connector can only ever be
 * approved by the person Tether exists to protect. A client token typed into
 * the page is the fallback for when the phone is not to hand.
 *
 * Every grant becomes a peer, so a connected client shows up by name, can be
 * addressed by other agents, and is revoked with `peer revoke` like any other.
 *
 * Off unless OAUTH_ENABLED is set: registration is open by design (that is what
 * DCR means), and anyone who can reach /oauth/authorize can make the phone ask
 * a question. Turn it on when the server is deliberately exposed.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { db } from './db.ts';
import * as peers from './peers.ts';
import * as requests from './requests.ts';
import type { Peer } from './types.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id     TEXT PRIMARY KEY,
    client_name   TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  -- An authorization in flight: the page is open, the ask is on the phone.
  CREATE TABLE IF NOT EXISTS oauth_pending (
    id             TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    state          TEXT NOT NULL DEFAULT '',
    resource       TEXT NOT NULL DEFAULT '',
    request_id     TEXT NOT NULL,
    approved       INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL
  );

  -- Codes, access tokens and refresh tokens are stored as SHA-256 hashes: a
  -- copy of the database is not a copy of anyone's credentials.
  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash      TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource       TEXT NOT NULL DEFAULT '',
    expires_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    access_hash    TEXT PRIMARY KEY,
    refresh_hash   TEXT NOT NULL UNIQUE,
    client_id      TEXT NOT NULL,
    peer_name      TEXT NOT NULL,
    access_expires INTEGER NOT NULL,
    refresh_expires INTEGER NOT NULL,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_hash);
`);

const ACCESS_TTL_SEC = 3600;
const REFRESH_TTL_SEC = 90 * 86_400;
const CODE_TTL_SEC = 300;
const CONSENT_TTL_SEC = 300;
/** Pending consents allowed at once. Bounds how hard a stranger can ring the phone. */
const MAX_PENDING = 3;

export const enabled = (): boolean => config.oauthEnabled;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const mint = (prefix: string): string => `${prefix}${randomBytes(32).toString('base64url')}`;

/* ------------------------------------------------------------- metadata -- */

/**
 * The issuer is the origin the request arrived on. Tether answers on a LAN
 * address and a tunnel hostname at once, and each must describe itself in its
 * own terms or the client's issuer check fails.
 */
export function issuerFor(headers: { host?: string; proto?: string }): string {
  if (config.oauthIssuer) return config.oauthIssuer;
  const proto = headers.proto?.split(',')[0]?.trim() || 'http';
  return `${proto}://${headers.host ?? `localhost:${config.port}`}`;
}

export function resourceMetadata(issuer: string) {
  return {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    resource_name: config.serverName,
  };
}

export function serverMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

/* --------------------------------------------------------- registration -- */

export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Only https redirects, plus loopback http for local clients (Claude Code's own
 * OAuth flow listens on localhost). Anything else would let a registration send
 * a freshly minted code to an address nobody vetted.
 */
function acceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

type ClientRow = { client_id: string; client_name: string; redirect_uris: string };

export function register(body: unknown) {
  const b = (body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u) => typeof u === 'string') : [];
  if (uris.length === 0 || uris.length > 10 || !uris.every(acceptableRedirect)) {
    throw new OAuthError(
      'invalid_redirect_uri',
      'redirect_uris must be 1–10 https URLs (or http on localhost).',
    );
  }
  const name =
    typeof b.client_name === 'string' && b.client_name.trim()
      ? b.client_name.trim().slice(0, 80)
      : 'MCP client';
  const clientId = randomUUID();
  db.prepare(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)`,
  ).run(clientId, name, JSON.stringify(uris), Date.now());
  return {
    client_id: clientId,
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

function getClient(clientId: string): (ClientRow & { uris: string[] }) | null {
  const r = db.prepare(`SELECT * FROM oauth_clients WHERE client_id = ?`).get(clientId) as
    | ClientRow
    | undefined;
  return r ? { ...r, uris: JSON.parse(r.redirect_uris) as string[] } : null;
}

/* ------------------------------------------------------------ authorize -- */

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  resource?: string;
}

/**
 * Validate an authorization request and put the consent question to the human.
 *
 * Errors about the client or redirect are thrown, never redirected: until the
 * redirect URI is known to be registered, sending anything to it would make
 * this endpoint an open redirector.
 */
export function startAuthorization(p: AuthorizeParams, issuer: string) {
  const client = p.client_id ? getClient(p.client_id) : null;
  if (!client) throw new OAuthError('invalid_client', 'Unknown client_id.');
  const redirect = p.redirect_uri ?? (client.uris.length === 1 ? client.uris[0] : undefined);
  if (!redirect || !client.uris.includes(redirect)) {
    throw new OAuthError('invalid_request', 'redirect_uri does not match the registration.');
  }
  if (p.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'Only code is supported.');
  if (!p.code_challenge || p.code_challenge_method !== 'S256') {
    throw new OAuthError('invalid_request', 'PKCE with S256 is required.');
  }
  if (p.resource && p.resource.replace(/\/$/, '') !== `${issuer}/mcp`) {
    throw new OAuthError('invalid_target', 'This server only issues tokens for its own /mcp.');
  }

  const now = Date.now();
  db.prepare(`DELETE FROM oauth_pending WHERE expires_at < ?`).run(now);
  const live = (db.prepare(`SELECT COUNT(*) AS n FROM oauth_pending`).get() as { n: number }).n;
  if (live >= MAX_PENDING) {
    throw new OAuthError('temporarily_unavailable', 'Too many connection requests in flight.', 429);
  }

  const ask = requests.create({
    kind: 'ask',
    title: `Connect ${client.client_name} to Tether?`,
    body:
      `${client.client_name} wants to connect. It will be able to message, ask and call you. ` +
      `Only allow this if you started it yourself, just now.`,
    choices: ['Allow', 'Deny'],
    agentName: 'Tether',
    timeoutSec: CONSENT_TTL_SEC,
  });

  const id = randomUUID();
  db.prepare(
    `INSERT INTO oauth_pending (id, client_id, redirect_uri, code_challenge, state, resource, request_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    client.client_id,
    redirect,
    p.code_challenge,
    p.state ?? '',
    p.resource ?? '',
    ask.id,
    now,
    now + CONSENT_TTL_SEC * 1000,
  );
  return { pendingId: id, clientName: client.client_name };
}

type PendingRow = {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string;
  resource: string;
  request_id: string;
  approved: number;
  expires_at: number;
};

function redirectWith(p: PendingRow, params: Record<string, string>): string {
  const u = new URL(p.redirect_uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (p.state) u.searchParams.set('state', p.state);
  return u.toString();
}

function issueCode(p: PendingRow): string {
  const code = mint('tet_code_');
  db.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sha256(code), p.client_id, p.redirect_uri, p.code_challenge, p.resource, Date.now() + CODE_TTL_SEC * 1000);
  db.prepare(`DELETE FROM oauth_pending WHERE id = ?`).run(p.id);
  return redirectWith(p, { code });
}

export type ConsentState =
  | { state: 'pending' }
  | { state: 'done'; redirect: string }
  | { state: 'gone' };

/**
 * Where a consent stands. Polled by the authorize page.
 *
 * The answer is read from the ask itself, so whichever surface the human used
 * (the phone, the web UI, a notification button) is the one that counts.
 */
export function consentStatus(pendingId: string): ConsentState {
  const p = db.prepare(`SELECT * FROM oauth_pending WHERE id = ?`).get(pendingId) as
    | PendingRow
    | undefined;
  if (!p) return { state: 'gone' };

  const ask = requests.get(p.request_id);
  const now = Date.now();
  if (p.approved) return { state: 'done', redirect: issueCode(p) };
  if (ask?.status === 'answered' && ask.answer === 'Allow') return { state: 'done', redirect: issueCode(p) };

  const denied = ask && ask.status !== 'pending';
  if (denied || p.expires_at < now) {
    db.prepare(`DELETE FROM oauth_pending WHERE id = ?`).run(p.id);
    if (ask?.status === 'pending') requests.cancel(ask.id);
    return { state: 'done', redirect: redirectWith(p, { error: 'access_denied' }) };
  }
  return { state: 'pending' };
}

/**
 * Approve with a client credential typed into the page. Same authority as
 * answering the ask from the web UI, which that credential could do anyway.
 */
export function approveWithClientToken(pendingId: string, token: string, isClientToken: (t: string) => boolean): boolean {
  if (!token || !isClientToken(token)) return false;
  const p = db.prepare(`SELECT request_id FROM oauth_pending WHERE id = ?`).get(pendingId) as
    | { request_id: string }
    | undefined;
  if (!p) return false;
  db.prepare(`UPDATE oauth_pending SET approved = 1 WHERE id = ?`).run(pendingId);
  requests.resolve(p.request_id, 'answered', 'Allow', 'human');
  return true;
}

/* ---------------------------------------------------------------- token -- */

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * One peer per client registration. Named after the client so the phone says
 * "claude asked" rather than an opaque id, with a suffix when that name is taken.
 */
function peerForClient(clientId: string): Peer {
  const client = getClient(clientId);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client_id.');
  const tool = `oauth:${clientId}`;
  const existing = peers.list().find((p) => p.tool === tool);
  if (existing) return existing;

  const base =
    peers
      .normalizeName(client.client_name)
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'connector';
  for (let i = 0; i < 50; i++) {
    const name = i === 0 ? base : `${base}-${i + 1}`;
    if (!peers.validName(name) || peers.get(name)) continue;
    // No static token: the OAuth tokens below are this peer's only credential.
    return peers.registerTokenless({
      name,
      kind: 'agent',
      tool,
      description: `Connected over OAuth as ${client.client_name}`,
    });
  }
  throw new OAuthError('server_error', 'Could not name a peer for this client.', 500);
}

function issueTokens(clientId: string, peerName: string) {
  const access = mint('tet_oat_');
  const refresh = mint('tet_ort_');
  const now = Date.now();
  db.prepare(
    `INSERT INTO oauth_tokens (access_hash, refresh_hash, client_id, peer_name, access_expires, refresh_expires, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sha256(access), sha256(refresh), clientId, peerName, now + ACCESS_TTL_SEC * 1000, now + REFRESH_TTL_SEC * 1000, now);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SEC,
    refresh_token: refresh,
  };
}

type CodeRow = {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: number;
};

export function token(body: Record<string, unknown>) {
  const str = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const grant = str('grant_type');

  if (grant === 'authorization_code') {
    const hash = sha256(str('code'));
    const row = db.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ?`).get(hash) as
      | CodeRow
      | undefined;
    // Single use, whatever happens next: a code that fails verification once
    // must not be retried against a different verifier.
    db.prepare(`DELETE FROM oauth_codes WHERE code_hash = ?`).run(hash);
    if (!row || row.expires_at < Date.now()) throw new OAuthError('invalid_grant', 'Code is invalid or expired.');
    if (row.client_id !== str('client_id')) throw new OAuthError('invalid_grant', 'Code was issued to another client.');
    if (str('redirect_uri') && str('redirect_uri') !== row.redirect_uri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match.');
    }
    if (!sameString(s256(str('code_verifier')), row.code_challenge)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed.');
    }
    const peer = peerForClient(row.client_id);
    return issueTokens(row.client_id, peer.name);
  }

  if (grant === 'refresh_token') {
    const hash = sha256(str('refresh_token'));
    const row = db.prepare(`SELECT * FROM oauth_tokens WHERE refresh_hash = ?`).get(hash) as
      | { client_id: string; peer_name: string; refresh_expires: number }
      | undefined;
    // Rotation: the old pair dies whether or not the new one is ever used.
    db.prepare(`DELETE FROM oauth_tokens WHERE refresh_hash = ?`).run(hash);
    if (!row || row.refresh_expires < Date.now()) throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired.');
    if (str('client_id') && str('client_id') !== row.client_id) {
      throw new OAuthError('invalid_grant', 'Refresh token was issued to another client.');
    }
    const peer = peers.get(row.peer_name);
    if (!peer || peer.revoked) throw new OAuthError('invalid_grant', 'This connection was revoked.');
    return issueTokens(row.client_id, row.peer_name);
  }

  throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

/** Resolve an OAuth access token to its peer, or null. */
export function authenticate(accessToken: string): Peer | null {
  if (!accessToken.startsWith('tet_oat_')) return null;
  const row = db
    .prepare(`SELECT peer_name, access_expires FROM oauth_tokens WHERE access_hash = ?`)
    .get(sha256(accessToken)) as { peer_name: string; access_expires: number } | undefined;
  if (!row || row.access_expires < Date.now()) return null;
  const peer = peers.get(row.peer_name);
  return peer && !peer.revoked ? peer : null;
}

/* ------------------------------------------------------------ the page -- */

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The consent page: waits for the phone, with a token form as the fallback. */
export function consentPage(pendingId: string, clientName: string): string {
  const id = esc(pendingId);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Tether</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0E1012;color:#ECEEF0;font:16px/1.5 system-ui,sans-serif}
main{max-width:380px;padding:32px 24px}
h1{font-size:24px;margin:0 0 8px;letter-spacing:-.02em}
p{color:#A9B1BA;margin:0 0 20px}
.wait{display:flex;gap:10px;align-items:center;padding:14px 16px;border-radius:14px;background:#171A1E;margin-bottom:24px}
.dot{width:10px;height:10px;border-radius:50%;background:#7CF5C3;animation:p 1.4s infinite}
@keyframes p{50%{opacity:.25}}
details{color:#A9B1BA}
label{display:block;margin:12px 0 6px;font-size:14px}
input{width:100%;box-sizing:border-box;height:44px;border-radius:10px;border:1px solid #2F353C;background:#13161A;color:#ECEEF0;padding:0 12px;font-size:15px}
button{margin-top:12px;height:44px;width:100%;border:0;border-radius:10px;background:#7CF5C3;color:#06231A;font-weight:600;font-size:15px}
#err{color:#FF8A80;font-size:14px;min-height:20px}
</style></head>
<body><main>
<h1>Connect ${esc(clientName)}</h1>
<p>Approve this on your phone. Tether just asked you there.</p>
<div class="wait" role="status"><span class="dot" aria-hidden="true"></span><span>Waiting for your answer…</span></div>
<details><summary>Phone not to hand?</summary>
<form method="post" action="/oauth/authorize/${id}">
<label for="t">Client token</label>
<input id="t" name="client_token" type="password" autocomplete="off" required>
<button type="submit">Approve</button>
</form></details>
<div id="err"></div>
</main>
<script>
(async function poll(){
  try{
    const r = await fetch('/oauth/authorize/${id}/status');
    const s = await r.json();
    if (s.state === 'done') { location.replace(s.redirect); return; }
    if (s.state === 'gone') { document.getElementById('err').textContent = 'This request expired. Start the connection again.'; return; }
  }catch(e){}
  setTimeout(poll, 2000);
})();
</script>
</body></html>`;
}
