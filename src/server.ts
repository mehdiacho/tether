/**
 * HTTP + WebSocket surface.
 *
 *   /mcp             streamable HTTP MCP endpoint  (agent tokens)
 *   /api/*           REST for the phone and web UI (client tokens)
 *   /api/stream      WebSocket: live pending-request feed
 *   /api/call/stream WebSocket: live call state and audio segments
 *   /audio/:id       voice message playback
 *   /health          unauthenticated liveness
 *
 * Agent tokens and client tokens are deliberately separate sets. An agent must
 * not be able to answer its own question — that would make the human-in-the-loop
 * guarantee decorative.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.ts';
import { buildMcpServer } from './mcp.ts';
import * as requests from './requests.ts';
import { getAudio, getByActionToken, putAudio } from './db.ts';
import { configuredChannels } from './channels.ts';
import * as callsession from './callsession.ts';
import * as devices from './devices.ts';
import { pushEnabled } from './push.ts';
import * as scheduler from './scheduler.ts';
import * as sessions from './sessions.ts';
import * as store from './db.ts';
import { encodeQr, toSvg } from './qr.ts';
import { transcribe } from './stt.ts';
import type { CallEvent, Device, ServerEvent } from './types.ts';

function param(req: Request, name: string): string {
  const v = (req.params as Record<string, string | undefined>)[name];
  return typeof v === 'string' ? v : '';
}

/** A schedule stored with a since-broken cron must not break the whole list. */
function safeNextRuns(cron: string, tz: string): string[] {
  try {
    return scheduler.nextRuns(cron, tz);
  } catch {
    return [];
  }
}

function bearer(req: Request): string | null {
  const h = req.header('authorization');
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  const q = req.query['token'];
  return typeof q === 'string' ? q : null;
}

function requireToken(allowed: Set<string>, label: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = bearer(req);
    if (!token || !allowed.has(token)) {
      res.status(401).json({ error: `A valid ${label} token is required.` });
      return;
    }
    next();
  };
}

/** The device behind the current request, when it authenticated as one. */
type WithDevice = Request & { device?: Device };

/**
 * Client auth accepts two kinds of credential: the static tokens from
 * CLIENT_TOKENS (web UI, curl, the NAS) and per-device tokens issued at
 * pairing. Device tokens are what make "revoke my stolen phone" a one-row
 * change instead of a rotation that logs out everything else.
 */
function requireClientAuth(req: Request, res: Response, next: NextFunction): void {
  const token = bearer(req);
  const auth = token ? devices.authenticate(token) : null;
  if (!auth) {
    res.status(401).json({ error: 'A valid client token is required.' });
    return;
  }
  if (auth.kind === 'device') (req as WithDevice).device = auth.device;
  next();
}

/**
 * Accept what an operator would actually type — `192.168.0.2:8790`,
 * `tether.example.com`, a full URL with a stray trailing slash — and return a
 * canonical origin, or null if it is not a usable http(s) address.
 */
function normalizeServerUrl(raw: string): string | null {
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return null;
  }
}

/**
 * Addresses a phone might use to reach this server, best guess first.
 *
 * This exists because the server cannot know its own public address: it sees
 * container-internal interfaces, and the phone may be on wifi, on a VPN, or
 * coming in through a reverse proxy. So offer the three things that are
 * knowable — what the operator configured, what they are browsing right now,
 * and the host's LAN addresses — and let them pick. Guessing wrong produces a
 * QR that scans and then cannot connect, which is a worse failure than asking.
 */
function candidateAddresses(req: Request): string[] {
  const out: string[] = [];
  const add = (raw: string | undefined | null): void => {
    if (!raw) return;
    const url = normalizeServerUrl(raw);
    if (url && !out.includes(url)) out.push(url);
  };

  add(config.publicUrl);

  // Whatever the operator loaded this page over. If it worked for them it is at
  // least a real route to this process. Loopback is excluded: it would resolve
  // to the phone itself.
  const host = req.get('host');
  if (host && !/^(localhost|127\.|\[::1\])/i.test(host)) {
    const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0]!.trim();
    add(`${proto}://${host}`);
  }

  for (const addresses of Object.values(networkInterfaces())) {
    for (const addr of addresses ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) add(`http://${addr.address}:${config.port}`);
    }
  }

  return out;
}

export function createApp(): { app: express.Express; attach: (s: Server) => void } {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // The web UI. Unauthenticated on purpose — it's a shell that asks for a token
  // and then talks to the authenticated API. Serving it freely means the page can
  // be bookmarked to a phone home screen without a secret in the URL.
  app.get('/', (_req, res) => {
    res.sendFile(join(import.meta.dirname, 'web', 'index.html'));
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      pending: requests.listPending().length,
      channels: configuredChannels(),
    });
  });

  /* ----------------------------------------------------------------- MCP -- */

  const requireAgent = requireToken(config.agentTokens, 'agent');

  app.all('/mcp', requireAgent, async (req: Request, res: Response) => {
    // Stateless transport: a fresh server per request. Blocking tool calls are
    // held open by the HTTP request itself, and durability lives in SQLite, so
    // there is no in-memory session to lose on restart.
    const agentName = req.header('x-agent-name') || 'agent';
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      void transport.close();
    });

    try {
      const server = buildMcpServer(agentName);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[tether] MCP request failed:', err);
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    }
  });

  /* --------------------------------------------------------- client REST -- */

  const requireClient = requireClientAuth;

  app.get('/api/requests', requireClient, (req, res) => {
    const all = req.query['all'] === '1';
    res.json({ requests: all ? requests.listRecent(100) : requests.listPending() });
  });

  app.get('/api/requests/:id', requireClient, (req, res) => {
    const r = requests.get(param(req, 'id'));
    if (!r) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(r);
  });

  app.post('/api/requests/:id/answer', requireClient, (req, res) => {
    const { answer, refused } = req.body as { answer?: string; refused?: boolean };
    const status = refused ? 'refused' : 'answered';

    const r = requests.resolve(param(req, 'id'), status, refused ? null : (answer ?? ''));
    if (!r) {
      // Not an error worth alarming a phone client over — someone else answered.
      res.status(409).json({ error: 'already resolved', request: requests.get(param(req, 'id')) });
      return;
    }
    res.json(r);
  });

  /**
   * One-tap answer endpoint, for notification action buttons.
   *
   * Authenticated by the request's own single-purpose action token rather than a
   * client token: the URL sits in a notification payload, so whatever authorises
   * it must be useless for anything except this one request.
   */
  app.post('/a/:id/:token', (req, res) => {
    const id = param(req, 'id');
    const found = getByActionToken(id, param(req, 'token'));
    if (!found) {
      res.status(404).type('text/plain').send('Unknown or expired request.');
      return;
    }

    const refused = req.query['refused'] === '1';
    const answer = typeof req.query['answer'] === 'string' ? req.query['answer'] : '';

    const r = requests.resolve(id, refused ? 'refused' : 'answered', refused ? null : answer);
    res
      .status(r ? 200 : 409)
      .type('text/plain')
      .send(r ? (refused ? 'Refused.' : `Sent: ${answer}`) : 'Already answered.');
  });

  function serveAudio(res: Response, audioId: string | null): void {
    const a = audioId ? getAudio(audioId) : null;
    if (!a) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(Buffer.from(a.bytes));
  }

  app.get('/audio/:id', requireClient, (req, res) => {
    serveAudio(res, param(req, 'id'));
  });

  /**
   * Playback by request, authenticated by that request's own action token.
   *
   * This is what a notification attachment or a Click URL points at. It has to
   * be openable by whatever handles the tap — a phone browser with no client
   * token — so it is authorised by a credential that unlocks exactly one
   * recording and nothing else.
   */
  app.get('/v/:id/:token', (req, res) => {
    const found = getByActionToken(param(req, 'id'), param(req, 'token'));
    if (!found) {
      res.status(404).type('text/plain').send('Unknown or expired recording.');
      return;
    }
    serveAudio(res, found.audioId);
  });

  /* ------------------------------------------------------- pairing/devices -- */

  /**
   * Mint a pairing code, and everything needed to put it on a screen.
   *
   * Requires an existing client credential — this is the web UI (or the
   * operator at a terminal) vouching for a new phone, not an open door.
   *
   * The QR is rendered here rather than in the browser so that every surface
   * that can reach this endpoint — the web UI, a terminal, some future desktop
   * app — gets an identical code with no client-side library.
   */
  app.post('/api/pair/start', requireClient, (req, res) => {
    const addresses = candidateAddresses(req);
    const requested = (req.body as { url?: string } | undefined)?.url;
    const url = requested ? normalizeServerUrl(requested) : (addresses[0] ?? null);

    if (!url) {
      res.status(400).json({
        error: requested
          ? 'That is not a usable http(s) address.'
          : 'This server cannot work out its own address. Set PUBLIC_URL, or pass one as "url".',
      });
      return;
    }

    const { code, expiresAt } = devices.createPairingCode();
    const uri = devices.pairingUri(url, code);

    res.json({
      code,
      expiresAt,
      url,
      addresses,
      uri,
      // Level M: the panel showing this is a screen, not a printed label, so the
      // extra correction a higher level buys is wasted density.
      qrSvg: toSvg(encodeQr(uri, 'M'), { border: 2 }),
    });
  });

  /**
   * Has that code been used yet?
   *
   * Lets the screen displaying a QR confirm the pairing itself, instead of the
   * operator scanning and then going to look for the device in a list.
   */
  app.get('/api/pair/status/:code', requireClient, (req, res) => {
    res.json(devices.pairingStatus(param(req, 'code')));
  });

  /**
   * Claim a pairing code. Deliberately UNAUTHENTICATED: the phone has no
   * credential yet, and the short-lived single-use code IS the credential.
   * It expires in minutes and dies the moment it is used.
   */
  app.post('/api/pair/claim', (req, res) => {
    const { code, name, platform, pushToken } = req.body as {
      code?: string;
      name?: string;
      platform?: Device['platform'];
      pushToken?: string;
    };
    if (!code) {
      res.status(400).json({ error: 'A pairing code is required.' });
      return;
    }

    const claimed = devices.claim({
      code,
      name: name ?? 'Phone',
      platform: platform ?? 'android',
      pushToken: pushToken ?? null,
    });
    if (!claimed) {
      res.status(400).json({ error: 'That code is invalid, expired or already used.' });
      return;
    }

    res.status(201).json({
      deviceId: claimed.device.id,
      clientToken: claimed.clientToken,
      name: claimed.device.name,
    });
  });

  app.get('/api/devices', requireClient, (_req, res) => {
    // The client token is a credential; listing devices must never echo it back.
    res.json({
      devices: devices.list().map(({ clientToken: _omit, pushToken, ...d }) => ({
        ...d,
        hasPushToken: Boolean(pushToken),
      })),
      pushConfigured: pushEnabled(),
    });
  });

  /**
   * Refresh this device's FCM token. Called on every app start and whenever
   * Firebase rotates it — a stale token is a phone that silently stops ringing.
   */
  app.post('/api/devices/push-token', requireClient, (req, res) => {
    const device = (req as WithDevice).device;
    const { pushToken } = req.body as { pushToken?: string };
    if (!device) {
      res.status(403).json({ error: 'Only a paired device can register a push token.' });
      return;
    }
    if (!pushToken) {
      res.status(400).json({ error: 'pushToken is required.' });
      return;
    }
    res.json({ ok: devices.setPushToken(device.id, pushToken) });
  });

  app.delete('/api/devices/:id', requireClient, (req, res) => {
    const ok = devices.revoke(param(req, 'id'));
    res.status(ok ? 200 : 404).json({ ok });
  });

  /* ---------------------------------------------------------------- calls -- */

  app.get('/api/calls', requireClient, (_req, res) => {
    res.json({ calls: callsession.listRecent(50) });
  });

  app.get('/api/calls/:id', requireClient, (req, res) => {
    const call = callsession.get(param(req, 'id'));
    if (!call) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(call);
  });

  /**
   * Pick up.
   *
   * 409 is the normal, expected outcome for every device that did not win the
   * race — all of them ring, one answers. The app treats it as "someone else
   * got it", not as an error.
   */
  app.post('/api/calls/:id/answer', requireClient, (req, res) => {
    const device = (req as WithDevice).device;
    const result = callsession.answer(param(req, 'id'), device?.id ?? 'web');
    if (!result) {
      res.status(409).json({ error: 'already answered, declined or missed' });
      return;
    }
    res.json(result);
  });

  app.post('/api/calls/:id/decline', requireClient, (req, res) => {
    const call = callsession.decline(param(req, 'id'));
    res.status(call ? 200 : 409).json(call ?? { error: 'not ringing' });
  });

  /**
   * The human's turn on a live call.
   *
   * Accepts either the phone's own transcript, the raw audio, or both. Both is
   * the interesting case: the text starts the agent's turn immediately while
   * the audio still gets archived and, under a server-side provider, produces
   * the better transcript that actually gets stored.
   *
   * Audio arrives base64 in JSON rather than as multipart because an utterance
   * is a few seconds of AAC — tens of kilobytes — and one body shape is far
   * less to get wrong on the phone than two.
   */
  app.post('/api/calls/:id/utterance', requireClient, async (req, res) => {
    const callId = param(req, 'id');
    const call = callsession.get(callId);
    if (!call) {
      res.status(404).json({ error: 'no such call' });
      return;
    }
    if (call.state !== 'answered') {
      res.status(409).json({ error: `call is ${call.state}` });
      return;
    }

    const body = (req.body ?? {}) as { text?: string; audio?: string; mime?: string };
    const audio = body.audio ? Buffer.from(body.audio, 'base64') : null;
    const deviceText = typeof body.text === 'string' ? body.text : null;

    if (!audio?.byteLength && !deviceText?.trim()) {
      res.status(400).json({ error: 'Send text, audio, or both.' });
      return;
    }

    let transcript;
    try {
      transcript = await transcribe(audio, deviceText, body.mime || 'audio/mp4');
    } catch (err) {
      res.status(422).json({ error: (err as Error).message });
      return;
    }

    // Keep the recording: like the agent's own speech, the human's turn is the
    // only artefact of a call, so it must survive the audio pruner.
    let audioId: string | null = null;
    if (audio?.byteLength) {
      audioId = randomUUID();
      putAudio(audioId, body.mime || 'audio/mp4', audio, true);
    }

    const turn = callsession.hear(callId, transcript.text, transcript.provider, audioId);
    if (!turn) {
      res.status(409).json({ error: 'call ended before that arrived' });
      return;
    }

    res.status(201).json({ turn, sttMs: transcript.ms });
  });

  /** The whole conversation so far, both sides, in order. */
  app.get('/api/calls/:id/turns', requireClient, (req, res) => {
    res.json({ turns: callsession.turns(param(req, 'id')) });
  });

  /** One turn's recording — the agent's speech, or the human's own words. */
  app.get('/api/calls/:id/turns/:turnId/audio', requireClient, (req, res) => {
    const turnId = param(req, 'turnId');
    const turn = callsession.turns(param(req, 'id')).find((t) => t.id === turnId);
    serveAudio(res, turn?.audioId ?? null);
  });

  app.post('/api/calls/:id/end', requireClient, (req, res) => {
    const device = (req as WithDevice).device;
    const call = callsession.end(param(req, 'id'), device?.id);
    res.status(call ? 200 : 409).json(call ?? { error: 'not active' });
  });

  /* ------------------------------------------------- sessions & agents -- */

  /**
   * Resolve either id space.
   *
   * Hooks know a session only by the id Claude Code gave it; the app knows it
   * only by Tether's. Rather than making one of them translate, both are
   * accepted here. They are disjoint in practice — Tether mints its own uuid —
   * and Tether's own id is tried first, so a collision could only ever resolve
   * to the row the app meant.
   */
  function resolveSession(raw: string, tool = 'claude-code') {
    return sessions.get(raw) ?? store.getSessionByExternal(tool, raw);
  }

  // Registration is agent-token work: a session speaking about itself. Client
  // tokens are for the human's devices, and a phone must never be able to
  // invent a session that something will then try to deliver into.
  app.post('/api/sessions/register', requireAgent, (req, res) => {
    const body = req.body as sessions.RegisterArgs;
    if (!body?.externalId) {
      res.status(400).json({ error: 'externalId is required.' });
      return;
    }
    res.status(201).json(sessions.register(body));
  });

  app.post('/api/sessions/:id/state', requireAgent, async (req, res) => {
    const session = resolveSession(param(req, 'id'));
    if (!session) {
      res.status(404).json({ error: 'no such session' });
      return;
    }
    const body = req.body as sessions.StateArgs;
    const allowed = ['working', 'idle', 'waiting', 'ended'];
    if (!allowed.includes(body?.state)) {
      res.status(400).json({ error: `state must be one of ${allowed.join(', ')}` });
      return;
    }
    res.json(await sessions.setState(session.id, body));
  });

  app.post('/api/sessions/:id/message', requireAgent, (req, res) => {
    const session = resolveSession(param(req, 'id'));
    if (!session) {
      res.status(404).json({ error: 'no such session' });
      return;
    }
    const { text } = req.body as { text?: string };
    if (!text?.trim()) {
      res.status(400).json({ error: 'text is required.' });
      return;
    }
    res.status(201).json(sessions.note(session.id, text.trim()));
  });

  app.post('/api/sessions/:id/end', requireAgent, (req, res) => {
    const session = resolveSession(param(req, 'id'));
    if (!session) {
      res.status(404).json({ error: 'no such session' });
      return;
    }
    res.json(sessions.end(session.id));
  });

  /* ------------------------------------------------------------- relay -- */

  /**
   * A relay's work queue, long-polled.
   *
   * Long-poll rather than a socket because of what a relay actually is: a
   * Claude session running a shell command. It can hold an HTTP request open
   * inside a single tool call; it cannot hold a WebSocket open across them.
   */
  app.get('/api/relay/:relay/outbox', requireAgent, async (req, res) => {
    const relay = param(req, 'relay');
    if (!relay) {
      res.status(400).json({ error: 'a relay name is required' });
      return;
    }
    const wait = Number(req.query['wait'] ?? 25);
    const items = await sessions.outbox(relay, Math.min(Math.max(wait, 0), 55) * 1000);
    res.json({ relay, messages: items });
  });

  app.post('/api/relay/messages/:id/settled', requireAgent, (req, res) => {
    const { ok, error } = req.body as { ok?: boolean; error?: string };
    const settled = sessions.settle(param(req, 'id'), ok !== false, error ?? null);
    res.status(settled ? 200 : 404).json(settled ?? { error: 'no such queued message' });
  });

  /* ------------------------------------------------- the human's views -- */

  app.get('/api/sessions', requireClient, (req, res) => {
    res.json({ sessions: sessions.view(req.query['all'] === '1') });
  });

  app.get('/api/sessions/:id', requireClient, (req, res) => {
    const session = resolveSession(param(req, 'id'));
    res.status(session ? 200 : 404).json(session ?? { error: 'no such session' });
  });

  app.get('/api/sessions/:id/messages', requireClient, (req, res) => {
    const session = resolveSession(param(req, 'id'));
    if (!session) {
      res.status(404).json({ error: 'no such session' });
      return;
    }
    res.json({ session, messages: sessions.messages(session.id) });
  });

  app.post('/api/sessions/:id/messages', requireClient, (req, res) => {
    const session = resolveSession(param(req, 'id'));
    if (!session) {
      res.status(404).json({ error: 'no such session' });
      return;
    }
    const { text } = req.body as { text?: string };
    if (!text?.trim()) {
      res.status(400).json({ error: 'text is required.' });
      return;
    }
    try {
      res.status(201).json(sessions.send(session.id, text.trim()));
    } catch (err) {
      // 409 rather than 400: the message is fine, the target is not reachable.
      // The app shows this verbatim, so it has to say what to do about it.
      const status = err instanceof sessions.NotAddressable ? 409 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  /* ------------------------------------------------------------ schedules -- */

  app.get('/api/schedules', requireClient, (_req, res) => {
    res.json({
      schedules: scheduler.listSchedules().map((s) => ({
        ...s,
        next: safeNextRuns(s.cron, s.timezone),
      })),
    });
  });

  app.post('/api/schedules', requireClient, (req, res) => {
    try {
      const s = scheduler.createSchedule(req.body as scheduler.CreateScheduleArgs);
      res.status(201).json({ ...s, next: safeNextRuns(s.cron, s.timezone) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/schedules/:id/enabled', requireClient, (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    const ok = scheduler.setScheduleEnabled(param(req, 'id'), enabled !== false);
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.delete('/api/schedules/:id', requireClient, (req, res) => {
    const ok = scheduler.deleteSchedule(param(req, 'id'));
    res.status(ok ? 200 : 404).json({ ok });
  });

  /* --------------------------------------------------------- WebSocket ---- */

  const clients = new Set<WebSocket>();

  const send = (ws: WebSocket, event: ServerEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };

  const broadcast = (event: ServerEvent) => {
    for (const ws of clients) send(ws, event);
  };

  requests.onChange((kind, request) => {
    broadcast(
      kind === 'created'
        ? { type: 'request.created', request }
        : { type: 'request.resolved', request },
    );
  });

  /**
   * Call sockets, keyed by call id.
   *
   * Kept separate from the request feed because the audiences differ: every
   * client wants to know a request appeared, but only devices involved in one
   * call want its audio segments. Broadcasting those to the web UI would push
   * MP3 URLs at a client with no business playing them.
   */
  const callClients = new Map<string, Set<WebSocket>>();

  callsession.onCallEvent((callId, event: CallEvent) => {
    const set = callClients.get(callId);
    if (!set) return;
    const payload = JSON.stringify(event);
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  });

  const attach = (server: Server) => {
    const wss = new WebSocketServer({ noServer: true });

    const callWss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      // A query token is the only option here — browsers cannot set headers on
      // a WebSocket handshake. Device tokens are accepted alongside the static
      // ones so the phone uses the same credential it already has.
      const token = url.searchParams.get('token') ?? '';
      if (!devices.isClientToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      if (url.pathname === '/api/stream') {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
        return;
      }

      const callMatch = /^\/api\/call\/([^/]+)\/stream$/.exec(url.pathname);
      if (callMatch) {
        const callId = callMatch[1]!;
        callWss.handleUpgrade(req, socket, head, (ws) => {
          let set = callClients.get(callId);
          if (!set) {
            set = new Set();
            callClients.set(callId, set);
          }
          set.add(ws);

          // Tell a joining device where the call already is. An app that
          // reconnects mid-call must not sit on a blank screen waiting for an
          // event that already fired.
          const current = callsession.get(callId);
          if (current && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'call.state', state: current.state, callId }));
          }

          const drop = () => {
            const bucket = callClients.get(callId);
            if (!bucket) return;
            bucket.delete(ws);
            if (bucket.size === 0) callClients.delete(callId);
          };
          ws.on('close', drop);
          ws.on('error', drop);
        });
        return;
      }

      socket.destroy();
    });

    wss.on('connection', (ws) => {
      clients.add(ws);
      // Send the current backlog immediately, so a phone that was offline sees
      // what it missed without a separate fetch.
      send(ws, { type: 'hello', pending: requests.listPending() });

      // Detect half-open sockets — a phone that lost signal without a FIN would
      // otherwise sit in the client set forever.
      let alive = true;
      ws.on('pong', () => {
        alive = true;
      });
      const ping = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, 30_000);
      ping.unref?.();

      ws.on('close', () => {
        clearInterval(ping);
        clients.delete(ws);
      });
      ws.on('error', () => {
        clearInterval(ping);
        clients.delete(ws);
      });
    });
  };

  return { app, attach };
}

export function start(): Server {
  const { app, attach } = createApp();
  const server = createServer(app);
  attach(server);
  server.listen(config.port, () => {
    console.log(`[tether] listening on :${config.port}`);
    console.log(`[tether] MCP endpoint: http://localhost:${config.port}/mcp`);
    const ch = configuredChannels();
    console.log(`[tether] channels: ${ch.length ? ch.join(', ') : 'none (app/web only)'}`);
  });
  return server;
}

export { randomUUID };
