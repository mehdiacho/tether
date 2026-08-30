#!/usr/bin/env node
/**
 * The relay's hands: everything about delivering a Tether message that is not
 * the delivery itself.
 *
 * ## Why this is split in half
 *
 * Getting a message into a running Claude Code session can only be done by
 * another Claude Code session, using its own peer messaging. There is no HTTP
 * endpoint, no CLI flag, no API — `claude -p --resume` starts a *new* process
 * over the transcript rather than reaching the live one, and Remote Control's
 * transport is Anthropic's with no third-party entry point.
 *
 * So the delivery step is a tool call, which means a model has to make it. That
 * is an awkward thing to put in a loop, so this script takes everything else:
 *
 *   poll   long-poll the queue and print what to deliver
 *   ack    report that a message landed
 *   fail   report that it did not, and why
 *
 * The session running this does the one thing only it can do — call
 * SendMessage — and shells out for the rest. See skills/tether-relay.
 *
 * ## Usage
 *
 *   node relay.mjs poll [--wait 25]
 *   node relay.mjs ack <messageId>
 *   node relay.mjs fail <messageId> "<reason>"
 *
 * Environment:
 *   TETHER_URL          the server                       (required)
 *   TETHER_AGENT_TOKEN  an agent token                   (required)
 *   TETHER_RELAY        this relay's name — must match what the sessions on
 *                       this machine registered with, or the queue is empty
 *                       forever and nothing says why.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const base = (process.env.TETHER_URL ?? '').replace(/\/+$/, '');
const token = process.env.TETHER_AGENT_TOKEN ?? '';
const relay = (process.env.TETHER_RELAY ?? '').trim();

function die(message) {
  console.error(message);
  process.exitCode = 1;
}

if (!base || !token || !relay) {
  die('Set TETHER_URL, TETHER_AGENT_TOKEN and TETHER_RELAY before running the relay.');
  process.exit(1);
}

function call(method, path, body, timeoutMs) {
  const target = new URL(`${base}${path}`);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = body === undefined ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method,
        // No pooling: this process is short-lived and a pooled socket would
        // outlive its work, holding the event loop open after the answer.
        agent: false,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`${res.statusCode} ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch {
            reject(new Error(`unreadable response: ${text.slice(0, 200)}`));
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case 'poll': {
      const flag = rest.indexOf('--wait');
      const wait = flag >= 0 ? Number(rest[flag + 1]) : 25;
      const seconds = Number.isFinite(wait) ? Math.min(Math.max(wait, 0), 55) : 25;
      // The server holds the request for `seconds`; allow it a margin to answer
      // before this side gives up, or a healthy long-poll looks like a failure.
      const { messages } = await call('GET', `/api/relay/${encodeURIComponent(relay)}/outbox?wait=${seconds}`, undefined, (seconds + 10) * 1000);
      if (messages.length === 0) {
        console.log('nothing queued');
        break;
      }
      // One line per message, in the order they were sent. Deliberately plain:
      // it is read by a model, and a table would only invite it to reformat.
      for (const item of messages) {
        console.log(
          [
            `id: ${item.message.id}`,
            `to: ${item.address}`,
            `session: ${item.title}`,
            `text: ${item.message.text}`,
          ].join('\n'),
        );
        console.log('---');
      }
      break;
    }

    case 'ack': {
      const id = rest[0];
      if (!id) throw new Error('usage: relay.mjs ack <messageId>');
      await call('POST', `/api/relay/messages/${encodeURIComponent(id)}/settled`, { ok: true }, 10_000);
      console.log(`delivered ${id}`);
      break;
    }

    case 'fail': {
      const [id, ...reason] = rest;
      if (!id) throw new Error('usage: relay.mjs fail <messageId> "<reason>"');
      await call(
        'POST',
        `/api/relay/messages/${encodeURIComponent(id)}/settled`,
        { ok: false, error: reason.join(' ') || 'Delivery failed.' },
        10_000,
      );
      console.log(`marked failed: ${id}`);
      break;
    }

    default:
      die('usage: relay.mjs poll [--wait 25] | ack <id> | fail <id> "<reason>"');
  }
} catch (err) {
  die(`relay: ${err.message}`);
}
