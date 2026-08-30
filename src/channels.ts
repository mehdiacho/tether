/**
 * Fan-out. A request reaches the human through every configured channel.
 *
 * This is the adoption lever: with Telegram configured, Tether is useful before
 * the Android app exists at all. The app becomes the best client rather than a
 * prerequisite.
 *
 * Telegram is a genuine `ask` channel — inline keyboards map directly onto
 * choices, so a question can be answered without leaving the chat. ntfy is
 * push-only, so it announces but cannot answer.
 */

import { config } from './config.ts';
import * as callsession from './callsession.ts';
import { getAudio } from './db.ts';
import { pushEnabled } from './push.ts';
import * as requests from './requests.ts';
import type { TetherRequest } from './types.ts';

const NTFY_PRIORITY: Record<string, string> = {
  min: '1',
  low: '2',
  default: '3',
  high: '4',
  urgent: '5',
};

/**
 * A call is the loudest thing Tether does, so it always goes out at max
 * priority regardless of what the caller asked for. If it should not ring
 * through, it should not have been a call.
 */
function ntfyPriority(r: TetherRequest): string {
  if (r.kind === 'call') return '5';
  return NTFY_PRIORITY[r.priority] ?? '3';
}

function summary(r: TetherRequest): string {
  const ctx = r.context ? Object.entries(r.context) : [];
  const ctxLine = ctx.length ? `\n\n${ctx.map(([k, v]) => `${k}: ${v}`).join('\n')}` : '';
  return `${r.body}${ctxLine}`;
}

/**
 * Playback URL for a request's recording, authenticated by that request's own
 * single-purpose action token.
 *
 * A notification payload is not a safe place for a client token, and an
 * attachment URL has to be openable by whatever handles the tap — so the token
 * embedded here must be worth nothing beyond this one request's audio.
 */
function audioUrl(r: TetherRequest): string | null {
  if (!r.audioId || !config.publicUrl) return null;
  return `${config.publicUrl}/v/${r.id}/${r.actionToken}`;
}

/* ------------------------------------------------------------------ ntfy -- */

/**
 * ntfy action buttons, which turn a push-only channel into one that can answer.
 *
 * Each button POSTs straight to Tether's one-tap endpoint carrying the request's
 * single-purpose action token — never a long-lived client token, which would
 * otherwise sit in every notification payload.
 *
 * ntfy allows at most 3 actions, so choices are capped at 2 plus Refuse. The web
 * UI remains the place to answer anything richer.
 */
function ntfyActions(r: TetherRequest): string | null {
  if (r.kind === 'notify' || !config.publicUrl) return null;
  // A call with no choices is an announcement, not a question. Yes/No buttons
  // on it would be asking about nothing.
  if (r.kind === 'call' && !r.choices?.length) return null;

  const answer = (label: string, value: string) =>
    `http, ${label}, ${config.publicUrl}/a/${r.id}/${r.actionToken}?answer=${encodeURIComponent(value)}, method=POST, clear=true`;

  const actions: string[] = [];

  if (r.choices?.length) {
    for (const c of r.choices.slice(0, 2)) actions.push(answer(c.slice(0, 24), c));
  } else if (r.kind === 'action') {
    actions.push(answer('Done', 'done'));
  } else {
    actions.push(answer('Yes', 'Yes'), answer('No', 'No'));
  }

  if (actions.length < 3) {
    actions.push(
      `http, Refuse, ${config.publicUrl}/a/${r.id}/${r.actionToken}?refused=1, method=POST, clear=true`,
    );
  }

  return actions.join('; ');
}

async function sendNtfy(r: TetherRequest): Promise<void> {
  const { url, topic, token } = config.ntfy;
  if (!url || !topic) return;

  const endpoint = `${url.replace(/\/$/, '')}/${topic}`;

  const headers: Record<string, string> = {
    Title: r.title,
    Priority: ntfyPriority(r),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (r.kind === 'call') headers['Tags'] = 'telephone_receiver';
  else if (r.kind !== 'notify') headers['Tags'] = 'question';

  const actions = ntfyActions(r);
  if (actions) headers['Actions'] = actions;

  // Tapping a call should land on the recording, not the pending list.
  const audio = audioUrl(r);
  headers['Click'] = audio && r.kind === 'call' ? audio : `${config.publicUrl || ''}/`;
  if (!config.publicUrl && !audio) delete headers['Click'];

  const body = summary(r);

  type FetchBody = NonNullable<RequestInit['body']>;
  const post = (extra: Record<string, string>, payload: FetchBody) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });

  try {
    // Upload the recording as a real ntfy attachment when there is one, so the
    // message is playable from the notification itself. This posts the bytes
    // rather than an `Attach` URL because the NAS is not publicly reachable —
    // a URL the phone cannot resolve off-LAN is worse than no attachment.
    const blob = r.audioId ? getAudio(r.audioId) : null;
    if (blob) {
      // With a file body, ntfy takes the text from the Message header, where a
      // literal \n is what produces a newline.
      const res = await post(
        {
          Message: body.replace(/\n/g, '\\n'),
          Filename: `${r.kind === 'call' ? 'call' : 'message'}-${r.id.slice(0, 8)}.mp3`,
          'Content-Type': 'audio/mpeg',
        },
        Buffer.from(blob.bytes) as unknown as FetchBody,
      );
      if (res.ok) return;
      // Attachments can be disabled server-side. Losing the audio is
      // acceptable; losing the message is not.
      console.warn(
        `[tether] ntfy rejected the attachment (${res.status}); resending as text`,
      );
    }

    await post({}, body);
  } catch (err) {
    console.error('[tether] ntfy delivery failed:', err);
  }
}

/* -------------------------------------------------------------- Telegram -- */

function telegramKeyboard(r: TetherRequest) {
  if (r.kind === 'notify') return undefined;
  // A call with no choices announces; it does not ask.
  if (r.kind === 'call' && !r.choices?.length) return undefined;

  const rows: { text: string; callback_data: string }[][] = [];

  if (r.choices?.length) {
    // callback_data is capped at 64 bytes, so send the choice INDEX, not the
    // text. A long choice label would silently break the button otherwise.
    for (const [i, choice] of r.choices.entries()) {
      rows.push([{ text: choice.slice(0, 60), callback_data: `a:${r.id}:${i}` }]);
    }
  } else if (r.kind === 'action') {
    rows.push([{ text: '✓ Done', callback_data: `a:${r.id}:done` }]);
  } else {
    rows.push([
      { text: 'Yes', callback_data: `a:${r.id}:yes` },
      { text: 'No', callback_data: `a:${r.id}:no` },
    ]);
  }

  rows.push([{ text: '✕ Refuse', callback_data: `r:${r.id}:` }]);
  return { inline_keyboard: rows };
}

async function tg(method: string, payload: unknown): Promise<unknown> {
  const { botToken } = config.telegram;
  if (!botToken) return null;
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  return res.json();
}

/**
 * Upload a recording to Telegram as a playable audio message.
 *
 * The bytes are uploaded rather than passed as a URL: Telegram's servers would
 * have to fetch a URL themselves, and the NAS is not publicly reachable. Sent as
 * `sendAudio` rather than `sendVoice` because sendVoice wants OGG/Opus and is
 * unreliable with MP3.
 */
async function sendTelegramAudio(r: TetherRequest, bytes: Uint8Array): Promise<boolean> {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) return false;

  const form = new FormData();
  form.set('chat_id', chatId);
  form.set('title', r.title.slice(0, 64));
  form.set('performer', r.kind === 'call' ? 'Tether call' : 'Tether');
  // Telegram caps captions at 1024 characters.
  form.set('caption', `${r.title}\n\n${summary(r)}`.slice(0, 1024));
  const keyboard = telegramKeyboard(r);
  if (keyboard) form.set('reply_markup', JSON.stringify(keyboard));
  form.set(
    'audio',
    new Blob([bytes], { type: 'audio/mpeg' }),
    `${r.kind === 'call' ? 'call' : 'message'}-${r.id.slice(0, 8)}.mp3`,
  );

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendAudio`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    console.warn(`[tether] Telegram sendAudio ${res.status}; falling back to text`);
    return false;
  }
  return true;
}

async function sendTelegram(r: TetherRequest): Promise<void> {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) return;

  try {
    const blob = r.audioId ? getAudio(r.audioId) : null;
    if (blob && (await sendTelegramAudio(r, blob.bytes))) return;

    await tg('sendMessage', {
      chat_id: chatId,
      text: `*${escapeMd(r.title)}*\n${escapeMd(summary(r))}`,
      parse_mode: 'MarkdownV2',
      reply_markup: telegramKeyboard(r),
    });
  } catch (err) {
    console.error('[tether] Telegram delivery failed:', err);
  }
}

function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/**
 * Long-poll Telegram for button presses so a question can be answered from the
 * chat. Runs only when a bot token is configured.
 */
export function startTelegramPoller(): () => void {
  const { botToken } = config.telegram;
  if (!botToken) return () => {};

  let offset = 0;
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const data = (await tg('getUpdates', { offset, timeout: 30 })) as {
          ok?: boolean;
          result?: { update_id: number; callback_query?: TelegramCallback }[];
        } | null;

        for (const update of data?.result ?? []) {
          offset = update.update_id + 1;
          const cb = update.callback_query;
          if (cb) handleCallback(cb);
        }
      } catch (err) {
        // A transient network blip must not kill the poller.
        console.error('[tether] Telegram poll error:', err);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  };

  void loop();
  return () => {
    stopped = true;
  };
}

interface TelegramCallback {
  id: string;
  data?: string;
  message?: { chat: { id: number }; message_id: number };
}

function handleCallback(cb: TelegramCallback): void {
  const raw = cb.data ?? '';
  const sep = raw.indexOf(':');
  const sep2 = raw.indexOf(':', sep + 1);
  if (sep < 0 || sep2 < 0) return;

  const verb = raw.slice(0, sep);
  const id = raw.slice(sep + 1, sep2);
  const value = raw.slice(sep2 + 1);

  const req = requests.get(id);
  let text = 'Already answered';

  if (req && req.status === 'pending') {
    if (verb === 'r') {
      requests.resolve(id, 'refused', null);
      text = 'Refused';
    } else {
      // Map the index back to the real choice text.
      const idx = Number.parseInt(value, 10);
      const answer =
        req.choices && Number.isInteger(idx) && req.choices[idx] !== undefined
          ? req.choices[idx]!
          : value;
      requests.resolve(id, 'answered', answer);
      text = `Sent: ${answer}`;
    }
  }

  void tg('answerCallbackQuery', { callback_query_id: cb.id, text });
}

/* ---------------------------------------------------------------- wiring -- */

/**
 * The app channel.
 *
 * A call does NOT go out here as a message — `placeCall` rings it through
 * `callsession.ring`, which is a different push type and a different UI on the
 * phone. Sending both would make every call arrive twice: once as a ringing
 * screen and once as a notification about the same thing.
 */
async function sendApp(r: TetherRequest): Promise<void> {
  if (!pushEnabled() || r.kind === 'call') return;
  try {
    await callsession.pushMessage(r);
  } catch (err) {
    console.error('[tether] app push failed:', (err as Error).message);
  }
}

export function startFanout(): () => void {
  return requests.onChange((event, request) => {
    if (event !== 'created') return;
    void sendApp(request);
    void sendNtfy(request);
    void sendTelegram(request);
  });
}

export function configuredChannels(): string[] {
  const out: string[] = [];
  if (pushEnabled()) out.push('app');
  if (config.ntfy.url && config.ntfy.topic) out.push('ntfy');
  if (config.telegram.botToken && config.telegram.chatId) out.push('telegram');
  return out;
}
