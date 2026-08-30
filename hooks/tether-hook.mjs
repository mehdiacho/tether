#!/usr/bin/env node
/**
 * Reports a Claude Code session to Tether.
 *
 * This is the "custom initialization" half of the session registry: one script,
 * wired to several hooks, that keeps Tether's view of what is running honest.
 * It is the supported half — hooks are documented, stable, and fire for every
 * session on every machine, which is exactly what the delivery path is not.
 *
 * ## Rules it follows, in order of importance
 *
 * 1. **Never break the session.** Every failure path exits 0 with no stderr. A
 *    notification server being down must not stop someone working. The one
 *    thing worse than Tether not knowing about a session is Tether making the
 *    session unusable.
 * 2. **Never block.** Hooks run inline, before the thing the human is waiting
 *    for. Everything here is capped at TIMEOUT_MS and abandoned after that.
 * 3. **Say nothing on stdout.** Some hook events treat stdout as context to
 *    inject into the conversation. This script has nothing to say to the model.
 * 4. **Exit promptly and cleanly.** Two ways this went wrong, both measured:
 *    calling process.exit() while undici tore down its keep-alive socket tripped
 *    a libuv assertion on Windows (stderr noise, exit 127, every single turn);
 *    and with fetch, an unreachable server left the process alive for 13s on
 *    the OS TCP retry, because AbortSignal aborts the request but not the
 *    socket handle holding the event loop open. Hence node:http with
 *    `agent: false` and an explicit destroy — the request is bounded, the
 *    socket really closes, and Node exits 0 on its own.
 *
 * ## Wiring
 *
 * Environment (from the shell, or the `env` block in settings.json):
 *   TETHER_URL          e.g. http://192.168.0.2:8790     (required)
 *   TETHER_AGENT_TOKEN  an agent token, not a client one  (required)
 *   TETHER_RELAY        name of the relay that can reach this machine.
 *                       Empty means "visible but not addressable" — the app
 *                       will show the session and refuse to message it.
 *   TETHER_ADDRESS      how the relay addresses this session. Defaults to the
 *                       session id, which is what SendMessage accepts.
 *   TETHER_RING         always | never | blocked   (default: blocked)
 *                       'blocked' rings only for permission prompts, which are
 *                       the ones that genuinely stop the run. Idle nudges get a
 *                       notification instead, because a phone that rings every
 *                       time a turn ends is a phone that gets silenced.
 *
 * See docs/sessions-and-agents.md for the whole picture.
 */

import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * Per-request cap.
 *
 * Two of these can run in one hook (Stop posts a message and then a state), so
 * the real budget is double this — and it has to stay under the `timeout` in
 * settings.json, or Claude Code kills the hook and the state never lands. A
 * notification server on the LAN that has not answered in two seconds is down,
 * not slow.
 */
const TIMEOUT_MS = 2_000;

const base = (process.env.TETHER_URL ?? '').replace(/\/+$/, '');
const token = process.env.TETHER_AGENT_TOKEN ?? '';
const relay = (process.env.TETHER_RELAY ?? '').trim();
const ringMode = (process.env.TETHER_RING ?? 'blocked').trim().toLowerCase();

/** Read the hook payload. A malformed one is not worth a stack trace. */
function input() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function post(path, body) {
  if (!base || !token) return Promise.resolve();
  let target;
  try {
    target = new URL(`${base}${path}`);
  } catch {
    return Promise.resolve();
  }
  const payloadText = JSON.stringify(body ?? {});
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const req = send(
      target,
      {
        method: 'POST',
        // No connection pool: a pooled socket outlives the work and keeps the
        // process running long after it has nothing left to do.
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payloadText),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        // The body is never read for content, only drained — leaving it
        // unconsumed keeps the socket, and the process, alive.
        res.resume();
        res.on('end', done);
        res.on('error', done);
      },
    );

    // Belt and braces: `timeout` covers a socket that goes quiet, the timer
    // covers everything else, and destroy() is what actually frees the handle.
    const timer = setTimeout(() => {
      req.destroy();
      done();
    }, TIMEOUT_MS);
    req.setTimeout(TIMEOUT_MS, () => req.destroy());
    // Deliberately silent on failure. See rule 1.
    req.on('error', done);
    req.end(payloadText);
  });
}

/**
 * Should this notification ring the phone?
 *
 * Claude Code sends two quite different things down the same hook: "I need
 * permission to run this" (the session is stopped until you answer) and "you
 * have not typed anything in a while" (it is not stopped at all). Treating them
 * the same is what turns a useful ring into an ignored one.
 */
function shouldRing(payload) {
  if (ringMode === 'always') return true;
  if (ringMode === 'never') return false;
  const kind = String(payload.notification_type ?? '').toLowerCase();
  const text = String(payload.notification_text ?? '').toLowerCase();
  if (kind.includes('idle') || text.includes('waiting for your input')) return false;
  return true;
}

/** First line, trimmed to something that reads on a phone. */
function summarize(text, max = 280) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const payload = input();
const event = payload.hook_event_name ?? '';
const sessionId = payload.session_id ?? '';

// A hook with no session id cannot be attributed to anything. Nothing useful
// to do with it, and inventing an id would put a ghost on the home page.
if (sessionId) {
  switch (event) {
    case 'SessionStart': {
      await post('/api/sessions/register', {
        externalId: sessionId,
        kind: 'session',
        cwd: payload.cwd ?? '',
        // The relay is what makes a session addressable, so a machine with no
        // relay running reports itself honestly as unreachable rather than
        // accepting messages nothing will collect.
        transport: relay ? 'relay' : 'none',
        relay,
        address: process.env.TETHER_ADDRESS ?? sessionId,
      });
      break;
    }

    case 'UserPromptSubmit': {
      // Doubles as the heartbeat that keeps the session off the stale sweep.
      await post(`/api/sessions/${sessionId}/state`, { state: 'working' });
      break;
    }

    case 'Stop': {
      const said = summarize(payload.last_assistant_message);
      if (said) await post(`/api/sessions/${sessionId}/message`, { text: said });
      await post(`/api/sessions/${sessionId}/state`, { state: 'idle' });
      break;
    }

    case 'Notification': {
      const why = summarize(payload.notification_text) || 'Needs your input';
      await post(`/api/sessions/${sessionId}/state`, {
        state: 'waiting',
        waitingOn: why,
        ring: shouldRing(payload),
        say: why,
      });
      break;
    }

    case 'SubagentStart': {
      const agentId = payload.agent_id;
      // Without its own id a subagent cannot be told apart from its siblings, and
      // registering it under the parent's id would overwrite the parent.
      if (!agentId) break;
      await post('/api/sessions/register', {
        externalId: agentId,
        kind: 'agent',
        parentExternalId: sessionId,
        agentType: payload.agent_type ?? '',
        cwd: payload.cwd ?? '',
      });
      break;
    }

    case 'SubagentStop': {
      const agentId = payload.agent_id;
      if (!agentId) break;
      const said = summarize(payload.last_assistant_message);
      if (said) await post(`/api/sessions/${agentId}/message`, { text: said });
      await post(`/api/sessions/${agentId}/end`, {});
      break;
    }

    case 'SessionEnd': {
      await post(`/api/sessions/${sessionId}/end`, {});
      break;
    }

    default:
      break;
  }
}
