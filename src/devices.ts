/**
 * Paired devices and how a phone gets its credentials.
 *
 * ## Why pairing codes exist
 *
 * The obvious design is "type your client token into the app". It is also
 * terrible: the tokens are long random strings, phones are the worst place to
 * type them, and anything long and awkward gets pasted through a clipboard
 * manager or a chat app on the way. So instead the server hands out a short
 * code that is worthless within minutes, and the app trades it for a real
 * token over TLS.
 *
 * ## Why each device gets its own token
 *
 * A shared secret cannot be revoked without breaking every other client. Given
 * that the whole point of this device is to receive calls and answers, "my
 * phone was stolen" needs to be a one-row change, not a rotation that also
 * knocks the web UI and the NAS offline.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import * as store from './db.ts';
import type { Device } from './types.ts';

/** Codes a human reads off a screen and types into a phone. */
const PAIRING_TTL_MS = 5 * 60 * 1000;

/**
 * Crockford-ish alphabet: no I, L, O, U. Removes the 0/O and 1/I confusions
 * that make a person retype a code, and drops the one letter combination
 * likeliest to spell something unfortunate.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function pairingCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    if (i === 3) out += '-';
  }
  return out; // XXXX-XXXX
}

export function createPairingCode(): { code: string; expiresAt: number } {
  store.purgePairingCodes();
  return store.insertPairingCode(pairingCode(), PAIRING_TTL_MS);
}

/**
 * The string that goes into a pairing QR code.
 *
 * A custom scheme rather than an https link, because the payload is meaningless
 * to anything but this app and an https URL invites a scanner to open a browser
 * instead. It carries only the server address and a code that dies in minutes —
 * never a token, so a QR left on a screen or in a screenshot is not a credential.
 *
 * The version field is there so a future app can recognise an older QR and say
 * so, rather than failing with a parse error.
 */
export function pairingUri(serverUrl: string, code: string): string {
  const params = new URLSearchParams({ v: '1', u: serverUrl.replace(/\/$/, ''), c: code });
  return `tether://pair?${params.toString()}`;
}

export interface PairingStatus {
  /** unknown covers expired-and-purged as well as never-existed. */
  state: 'pending' | 'claimed' | 'expired' | 'unknown';
  expiresAt?: number;
  device?: { id: string; name: string; platform: Device['platform'] } | null;
}

/**
 * What happened to a code — so the screen showing the QR can react instead of
 * asking the operator to go and check a device list.
 */
export function pairingStatus(code: string): PairingStatus {
  const row = store.getPairingCode(code.trim().toUpperCase());
  if (!row) return { state: 'unknown' };

  if (row.claimed_at) {
    const device = row.claimed_by ? store.getDevice(row.claimed_by) : null;
    return {
      state: 'claimed',
      expiresAt: row.expires_at,
      device: device ? { id: device.id, name: device.name, platform: device.platform } : null,
    };
  }

  return {
    state: row.expires_at > Date.now() ? 'pending' : 'expired',
    expiresAt: row.expires_at,
  };
}

export interface ClaimArgs {
  code: string;
  name: string;
  platform?: Device['platform'];
  pushToken?: string | null;
}

export interface ClaimResult {
  device: Device;
  /** The device's client token. Returned exactly once, at pairing time. */
  clientToken: string;
}

/**
 * Trade a pairing code for a device identity and a client token.
 *
 * Returns null when the code is unknown, expired, or already used. The claim is
 * a guarded UPDATE, so two phones racing on the same code produce one winner.
 */
export function claim(a: ClaimArgs): ClaimResult | null {
  const code = a.code.trim().toUpperCase();
  if (!store.claimPairingCode(code)) return null;

  const clientToken = randomBytes(32).toString('base64url');
  const device = store.insertDevice({
    id: randomUUID(),
    name: a.name.trim() || 'Phone',
    platform: a.platform ?? 'android',
    pushToken: a.pushToken?.trim() || null,
    clientToken,
  });

  store.setPairingClaimedBy(code, device.id);
  return { device, clientToken };
}

/**
 * Resolve a client token to a device, in constant time with respect to the
 * token's value.
 *
 * A plain SQLite lookup already avoids the classic early-exit comparison, but
 * the static tokens from CLIENT_TOKENS are compared in JS, so those go through
 * `timingSafeEqual`. Cheap, and it removes the question entirely.
 */
export function authenticate(token: string): { kind: 'static' } | { kind: 'device'; device: Device } | null {
  if (!token) return null;

  for (const known of config.clientTokens) {
    const a = Buffer.from(token);
    const b = Buffer.from(known);
    if (a.length === b.length && timingSafeEqual(a, b)) return { kind: 'static' };
  }

  const device = store.getDeviceByClientToken(token);
  if (device) {
    store.touchDevice(device.id);
    return { kind: 'device', device };
  }

  return null;
}

export function isClientToken(token: string): boolean {
  return authenticate(token) !== null;
}

/** Register or refresh this device's FCM token. Called on every app start. */
export function setPushToken(deviceId: string, pushToken: string): boolean {
  const device = store.getDevice(deviceId);
  if (!device || device.revoked) return false;
  store.setDevicePushToken(deviceId, pushToken);
  return true;
}

export const list = store.listDevices;
export const get = store.getDevice;
export const revoke = store.revokeDevice;
export const pushTargets = store.activePushTokens;

/** Drop tokens FCM reported as permanently dead. */
export function prunePushTokens(stale: string[]): void {
  for (const token of stale) store.clearPushToken(token);
}
