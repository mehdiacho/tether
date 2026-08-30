/**
 * The pending-request state machine. This is the actual product.
 *
 * An agent that calls `ask` needs to park — possibly for hours — without
 * spinning and without losing its place. Two mechanisms make that work:
 *
 *   1. In-memory waiters, so a still-connected agent is resumed the instant a
 *      human answers, with no polling.
 *   2. Durable state in SQLite, so an agent whose process died can come back
 *      with its request id and collect the answer it missed.
 *
 * The second is what makes this safe to depend on. Without it, a restart loses
 * the answer and the human gets asked the same question twice.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.ts';
import * as store from './db.ts';
import type { Priority, RequestKind, RequestStatus, TetherRequest } from './types.ts';

type Waiter = (r: TetherRequest) => void;

/** requestId -> callbacks waiting on it. Several agents may await one request. */
const waiters = new Map<string, Set<Waiter>>();

type Listener = (
  event: 'created' | 'resolved',
  request: TetherRequest,
) => void;
const listeners = new Set<Listener>();

export function onChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event: 'created' | 'resolved', request: TetherRequest): void {
  for (const fn of listeners) {
    // A misbehaving channel must not take down the request pipeline.
    try {
      fn(event, request);
    } catch (err) {
      console.error('[tether] listener failed:', err);
    }
  }
}

export interface CreateArgs {
  kind: RequestKind;
  title: string;
  body: string;
  choices?: string[] | null;
  context?: Record<string, unknown> | null;
  priority?: Priority;
  timeoutSec?: number;
  audioId?: string | null;
  agentName?: string;
}

export function create(args: CreateArgs): TetherRequest {
  const now = Date.now();
  const timeout = Math.min(
    Math.max(args.timeoutSec ?? config.defaultTimeoutSec, 5),
    config.maxTimeoutSec,
  );

  const req = store.insertRequest({
    id: randomUUID(),
    // Single-purpose: answers this one request and nothing else, so it is safe
    // to embed in a notification payload where a client token would not be.
    actionToken: randomBytes(12).toString('base64url'),
    kind: args.kind,
    title: args.title,
    body: args.body,
    choices: args.choices ?? null,
    context: args.context ?? null,
    priority: args.priority ?? 'default',
    audioId: args.audioId ?? null,
    agentName: args.agentName ?? 'agent',
    createdAt: now,
    expiresAt: now + timeout * 1000,
  });

  emit('created', req);
  return req;
}

/**
 * Resolve a request. Returns null when it was already resolved — the DB update
 * is guarded, so a race between the phone and the web UI has exactly one winner
 * rather than two conflicting answers.
 */
export function resolve(
  id: string,
  status: Exclude<RequestStatus, 'pending'>,
  answer: string | null,
): TetherRequest | null {
  const req = store.resolveRequest(id, status, answer);
  if (!req) return null;

  emit('resolved', req);
  wake(req);
  return req;
}

function wake(req: TetherRequest): void {
  const set = waiters.get(req.id);
  if (!set) return;
  waiters.delete(req.id);
  for (const fn of set) {
    try {
      fn(req);
    } catch (err) {
      console.error('[tether] waiter failed:', err);
    }
  }
}

/**
 * Await a request's resolution.
 *
 * Resolves immediately if the request is already settled, which is what makes
 * reconnect-after-crash work: the agent calls this with its saved id and gets
 * the answer straight from SQLite.
 *
 * `maxWaitMs` caps how long this individual call blocks — separate from the
 * request's own expiry. A caller that hits the cap gets the still-pending
 * request back and can call again, which is how long-polling stays stateless
 * without the agent ever seeing a difference.
 */
export function wait(id: string, maxWaitMs: number): Promise<TetherRequest | null> {
  const current = store.getRequest(id);
  if (!current) return Promise.resolve(null);
  if (current.status !== 'pending') return Promise.resolve(current);

  return new Promise((resolvePromise) => {
    let set = waiters.get(id);
    if (!set) {
      set = new Set();
      waiters.set(id, set);
    }
    const bucket = set;

    let done = false;
    let timer: NodeJS.Timeout;

    const finish = (r: TetherRequest | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bucket.delete(waiter);
      if (bucket.size === 0) waiters.delete(id);
      resolvePromise(r);
    };

    const waiter: Waiter = (r) => finish(r);
    bucket.add(waiter);

    timer = setTimeout(() => finish(store.getRequest(id)), maxWaitMs);
    // Don't hold the process open purely for a pending question.
    timer.unref?.();
  });
}

export function cancel(id: string): TetherRequest | null {
  return resolve(id, 'cancelled', null);
}

export const get = store.getRequest;
export const listPending = store.listPending;
export const listRecent = store.listRecent;

/**
 * Periodic sweep for expired requests. Without this a request whose deadline
 * passed while nothing was watching would sit "pending" forever and the agent
 * would never learn it timed out.
 */
export function startExpiryLoop(intervalMs = 15_000): () => void {
  const tick = () => {
    for (const id of store.expireDue()) {
      const req = store.getRequest(id);
      if (req) {
        emit('resolved', req);
        wake(req);
      }
    }
    // Audio is a cache; 48h is plenty for a voice message to be played.
    store.pruneAudio(48 * 60 * 60 * 1000);
  };

  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
