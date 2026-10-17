/**
 * The peer registry: who may address whom.
 *
 * Tether started as agent -> human. A peer is the generalisation: a named
 * endpoint that can be asked a question and can answer one. Claude Code is a
 * peer, Codex is a peer, and so is Mehdi — which is the point. `ask` never
 * cared who answered, only that somebody did, so making the addressee a field
 * turns one product into a rendezvous for both directions at once.
 *
 * Two rules hold this together, and both are about trust:
 *
 *   1. **Identity comes from the token.** The old `X-Agent-Name` header was a
 *      display label, and any client could set it to any value. Harmless while
 *      the only audience was a human reading a notification; a spoofing
 *      primitive the moment agents address each other. So the header is now
 *      cosmetic and the token decides who you are.
 *
 *   2. **Nothing authenticates as the human.** The human peer holds no token.
 *      A request addressed to a human is answerable only over the client
 *      surface — the phone, the web UI — and an agent that tries gets refused.
 *      Without this, one prompt-injected agent could grant itself every
 *      approval Tether exists to gate.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.ts';
import * as store from './db.ts';
import type { Peer, PeerKind } from './types.ts';

/** Peer names are addresses, so they have to be typed and compared reliably. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export function validName(name: string): boolean {
  return NAME_RE.test(name);
}

export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Mint a peer token.
 *
 * Prefixed so that a token found in a config file, a log or a paste is
 * immediately identifiable as a Tether peer credential and can be revoked
 * without anyone having to work out what it was for.
 */
export function mintToken(): string {
  return `tet_peer_${randomBytes(24).toString('base64url')}`;
}

export interface RegisterArgs {
  name: string;
  kind?: PeerKind;
  tool?: string;
  description?: string;
}

/**
 * Create a peer and return it along with its token — the ONLY time the token is
 * ever returned. It is not stored anywhere this process will read back out, and
 * `listPeers` never exposes it, so a leaked listing cannot impersonate anyone.
 */
export function register(a: RegisterArgs): { peer: Peer; token: string | null } {
  const name = normalizeName(a.name);
  if (!validName(name)) {
    throw new Error(
      `"${a.name}" is not a usable peer name. Use 2–32 lowercase letters, digits or hyphens.`,
    );
  }
  if (store.getPeer(name)) throw new Error(`Peer "${name}" already exists.`);

  const kind = a.kind ?? 'agent';
  const token = kind === 'human' ? null : mintToken();

  const peer = store.insertPeer({
    id: randomUUID(),
    name,
    kind,
    tool: a.tool ?? '',
    token,
    description: a.description ?? '',
    });
  return { peer, token };
}

/**
 * Resolve a bearer token to a peer.
 *
 * Falls back to the legacy `AGENT_TOKENS` set, which predates peers: those
 * tokens still authenticate and can still notify and ask the human, but they
 * map to no peer row, so they have no inbox and cannot be addressed. That is
 * deliberate — an unnamed agent should not be reachable, and upgrading is one
 * `peer add` away.
 */
export type Identity =
  | { kind: 'peer'; peer: Peer }
  | { kind: 'legacy'; name: string };

export function authenticate(token: string | null): Identity | null {
  if (!token) return null;

  const peer = store.getPeerByToken(token);
  if (peer) {
    store.touchPeer(peer.id);
    return { kind: 'peer', peer };
  }

  if (config.agentTokens.has(token)) return { kind: 'legacy', name: 'agent' };
  return null;
}

/** The addressable name for an identity. Legacy tokens have none. */
export function addressOf(id: Identity): string {
  return id.kind === 'peer' ? id.peer.name : '';
}

export const get = store.getPeer;
export const list = store.listPeers;
export const revoke = store.revokePeer;

/* ----------------------------------------------------------------- inbox -- */

export const cursorFor = (peer: string): number => store.getCursor(peer);
export const inbox = (peer: string, afterSeq: number, limit = 20) =>
  store.inboxAfter(peer, afterSeq, limit);
export const advance = (peer: string, seq: number): void => store.advanceCursor(peer, seq);

/**
 * Resolve an addressee supplied by an agent.
 *
 * Returns the peer, or a reason the send should be refused. Unknown names fail
 * loudly rather than silently dropping into a void: an agent that misaddresses
 * a question would otherwise block until timeout on a message nobody ever saw.
 */
export function resolveTarget(raw: string): { peer: Peer } | { error: string } {
  const name = normalizeName(raw);
  const peer = store.getPeer(name);
  if (!peer || peer.revoked) {
    const known = store
      .listPeers()
      .map((p) => p.name)
      .join(', ');
    return { error: `No peer named "${raw}". Known peers: ${known || '(none)'}.` };
  }
  return { peer };
}
