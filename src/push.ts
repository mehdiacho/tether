/**
 * Firebase Cloud Messaging, HTTP v1.
 *
 * This is the transport that lets Tether reach the phone when nothing is
 * connected — app swiped away, screen off, device in Doze. It is the reason the
 * Android app can replace ntfy rather than sit next to it.
 *
 * ## Why not the firebase-admin SDK
 *
 * It pulls ~50 transitive dependencies to do three things we can do with
 * `node:crypto` and `fetch`: sign a JWT, exchange it for an access token, POST
 * JSON. Tether has no build step and a deliberately small dependency surface;
 * adding an SDK for this would be the largest dependency in the project.
 *
 * ## Why every message is data-only
 *
 * FCM `notification` payloads are rendered by the system when the app is in the
 * background. That is exactly wrong for a call: the system would draw a plain
 * notification instead of letting the app throw up a full-screen ringing
 * screen. Data-only messages are always delivered to the app's code, so the app
 * decides what a call looks like. The cost is that we must set
 * `android.priority: HIGH` explicitly, or Doze will sit on them.
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from './config.ts';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let account: ServiceAccount | null = null;
let accountLoadFailed = false;

function serviceAccount(): ServiceAccount | null {
  if (account) return account;
  if (accountLoadFailed) return null;

  const path = config.fcm.credentialsPath;
  if (!path) {
    accountLoadFailed = true;
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new Error('missing project_id, client_email or private_key');
    }
    account = parsed as ServiceAccount;
    return account;
  } catch (err) {
    // Loud, once. A silently disabled push transport is the worst possible
    // failure mode for a tool whose entire job is reaching someone.
    console.error(
      `[tether] FCM disabled: could not read ${path} (${(err as Error).message})`,
    );
    accountLoadFailed = true;
    return null;
  }
}

export function pushEnabled(): boolean {
  return serviceAccount() !== null;
}

export function fcmProjectId(): string | null {
  return serviceAccount()?.project_id ?? null;
}

/* ------------------------------------------------------------ access token -- */

let cachedToken: { value: string; expiresAt: number } | null = null;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Mint a Google OAuth2 access token from the service account.
 *
 * Cached until 60s before expiry — tokens last an hour, and re-minting one per
 * push would add a round trip to every notification for no benefit.
 */
async function accessToken(): Promise<string | null> {
  const sa = serviceAccount();
  if (!sa) return null;

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.value;

  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(sa.private_key, 'base64url');
  const jwt = `${header}.${claims}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    console.error(`[tether] FCM token exchange failed (${res.status}): ${await res.text()}`);
    return null;
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) return null;

  cachedToken = {
    value: body.access_token,
    expiresAt: now + (body.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

/* -------------------------------------------------------------------- send -- */

export interface PushOptions {
  /** Registration tokens to deliver to. */
  tokens: string[];
  /** Data payload. FCM requires every value to be a string. */
  data: Record<string, string>;
  /**
   * Calls are time-critical and worthless late: a ring that arrives after the
   * caller gave up is noise. Messages should outlive a flat battery, so they
   * get a long TTL.
   */
  ttlSeconds?: number;
  /**
   * Collapse key. Two rings for the same call must not stack up if the phone
   * was briefly offline.
   */
  collapseKey?: string;
}

export interface PushResult {
  sent: number;
  /** Tokens FCM rejected as permanently invalid — the caller should drop them. */
  stale: string[];
}

/**
 * Deliver a data message to every token.
 *
 * FCM v1 has no multicast endpoint, so this is one request per token, in
 * parallel. That is fine at the scale this runs at (a person's own devices).
 *
 * `UNREGISTERED` and `INVALID_ARGUMENT` mean the token will never work again —
 * the app was uninstalled or the token was rotated. Those are returned as
 * `stale` so the registry can prune them; anything else is treated as transient
 * and left alone.
 */
export async function push(opts: PushOptions): Promise<PushResult> {
  const sa = serviceAccount();
  if (!sa || opts.tokens.length === 0) return { sent: 0, stale: [] };

  const token = await accessToken();
  if (!token) return { sent: 0, stale: [] };

  const endpoint = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  const ttl = opts.ttlSeconds ?? 3600;

  const results = await Promise.all(
    opts.tokens.map(async (deviceToken) => {
      const message: Record<string, unknown> = {
        token: deviceToken,
        data: opts.data,
        android: {
          priority: 'HIGH',
          ttl: `${ttl}s`,
          ...(opts.collapseKey ? { collapse_key: opts.collapseKey } : {}),
        },
      };

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message }),
          signal: AbortSignal.timeout(20_000),
        });

        if (res.ok) return { ok: true, stale: false };

        const text = await res.text();
        const permanent =
          res.status === 404 ||
          text.includes('UNREGISTERED') ||
          text.includes('INVALID_ARGUMENT');
        if (!permanent) {
          console.warn(`[tether] FCM send failed (${res.status}): ${text.slice(0, 200)}`);
        }
        return { ok: false, stale: permanent, token: deviceToken };
      } catch (err) {
        console.warn(`[tether] FCM send errored: ${(err as Error).message}`);
        return { ok: false, stale: false };
      }
    }),
  );

  return {
    sent: results.filter((r) => r.ok).length,
    stale: results.filter((r) => r.stale).map((r) => (r as { token: string }).token),
  };
}
