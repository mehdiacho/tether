/**
 * Configuration, read once at startup from the environment.
 *
 * Secrets never get written to disk by this app and never appear in logs.
 * Everything here comes from env vars (docker-compose reads .env).
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function float(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Comma-separated token list -> Set. Blank entries dropped. */
function tokenSet(name: string): Set<string> {
  return new Set(
    optional(name)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  );
}

export const config = {
  port: int('PORT', 8790),
  /** How clients reach this server. Used to build tappable action URLs. */
  publicUrl: optional('PUBLIC_URL', '').replace(/\/$/, ''),

  /**
   * What to call this server on the phone.
   *
   * Cosmetic, but it earns its keep once a server has several addresses: the
   * settings screen can then say "NAS" with the addresses underneath, instead
   * of making an IP stand in for an identity.
   */
  serverName: optional('SERVER_NAME', 'Tether'),
  dbPath: optional('DB_PATH', './data/tether.db'),

  /** Tokens that may CREATE requests (agents). */
  agentTokens: tokenSet('AGENT_TOKENS'),
  /** Tokens that may READ and ANSWER requests (phone, web UI). */
  clientTokens: tokenSet('CLIENT_TOKENS'),

  /**
   * Zone that schedules are interpreted in when the agent does not name one.
   * The NAS runs UTC, so leaving this unset would silently make "07:00" mean
   * 07:00 UTC — set DEFAULT_TIMEZONE to the operator's actual zone.
   */
  defaultTimezone:
    optional('DEFAULT_TIMEZONE') ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC',

  /** How long a pending request lives before it self-expires. */
  defaultTimeoutSec: int('DEFAULT_TIMEOUT_SEC', 3600),
  maxTimeoutSec: int('MAX_TIMEOUT_SEC', 86_400),

  /** Fish Audio — optional. Without a key, voice features are disabled. */
  fish: {
    apiKey: optional('FISH_API_KEY'),
    model: optional('FISH_MODEL', 's2.1-pro-free'),
    /** Default voice. Mehdi's pinned voice, overridable per call. */
    referenceId: optional('FISH_REFERENCE_ID'),
  },

  /**
   * Voice delivery tuning. `leadInMs` is not cosmetic: audio devices take a few
   * hundred ms to wake, and they eat whatever plays meanwhile, so a message
   * with no silent head starts mid-word. See voice.ts for the measurements.
   */
  voice: {
    leadInMs: int('VOICE_LEAD_IN_MS', 700),
    /** Fish expressiveness. 0–1; higher is more varied, less predictable. */
    temperature: float('VOICE_TEMPERATURE', 0.7),
    topP: float('VOICE_TOP_P', 0.7),
    /** 0.5–2.0. Slightly under 1 reads more clearly on a phone speaker. */
    speed: float('VOICE_SPEED', 0.95),
  },

  /**
   * Firebase Cloud Messaging — how the Android app is reached when nothing is
   * connected. Point this at a service-account JSON OUTSIDE the repo; the file
   * is a credential and must never be committed.
   *
   * Without it Tether still works, but only through the fan-out channels and
   * whatever web UI happens to be open. The app becomes deaf when backgrounded.
   */
  fcm: {
    credentialsPath: optional('FCM_CREDENTIALS'),
  },

  /** How long an unanswered call rings before it counts as missed. */
  callRingSeconds: int('CALL_RING_SECONDS', 45),

  /**
   * Speech to text, for calls the human can talk back on. See stt.ts for what
   * each provider costs you.
   *
   * `whisperUrl` and `cloudUrl` are OpenAI-compatible bases — the path
   * `/audio/transcriptions` is appended. For a self-hosted Whisper that is
   * typically `http://whisper:9000/v1`.
   */
  stt: {
    provider: (['device', 'whisper', 'cloud'] as const).find(
      (p) => p === optional('STT_PROVIDER', 'device'),
    ) ?? 'device',
    whisperUrl: optional('STT_WHISPER_URL').replace(/\/$/, ''),
    cloudUrl: optional('STT_CLOUD_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
    cloudApiKey: optional('STT_CLOUD_API_KEY'),
    model: optional('STT_MODEL', 'whisper-1'),
    /** Blank lets the model detect. Naming it is faster and less error-prone. */
    language: optional('STT_LANGUAGE'),
    timeoutMs: int('STT_TIMEOUT_MS', 30_000),
  },

  /**
   * Conversational calls: how long the line stays open waiting for the human to
   * say something before the call is treated as over.
   *
   * Generous on purpose. The agent may be thinking between turns, and a call
   * that hangs up on someone mid-sentence is worse than one that waits.
   */
  call: {
    listenTimeoutSec: int('CALL_LISTEN_TIMEOUT_SEC', 120),
    maxTurns: int('CALL_MAX_TURNS', 40),
  },

  /**
   * The session registry.
   *
   * `staleMs` is a heartbeat deadline, not a timeout: a session that is killed
   * outright never fires SessionEnd, so silence is the only evidence that it is
   * gone. Too short and a session that spends twenty minutes on one tool call
   * gets declared dead while it is working; too long and the home page shows
   * ghosts that swallow messages. Ten minutes, with hooks touching it on every
   * prompt and every turn, sits well clear of both.
   */
  session: {
    staleMs: int('SESSION_STALE_SEC', 600) * 1000,
    retainMs: int('SESSION_RETAIN_HOURS', 72) * 3_600_000,
  },

  /** Telegram fan-out — optional. */
  telegram: {
    botToken: optional('TELEGRAM_BOT_TOKEN'),
    chatId: optional('TELEGRAM_CHAT_ID'),
  },

  /** ntfy fan-out — optional. Reuses the server already on the NAS. */
  ntfy: {
    url: optional('NTFY_URL'),
    topic: optional('NTFY_TOPIC'),
    token: optional('NTFY_TOKEN'),
  },
} as const;

export function assertStartupConfig(): void {
  if (config.agentTokens.size === 0) {
    throw new Error('AGENT_TOKENS is empty — no agent could authenticate. Set at least one.');
  }
  if (config.clientTokens.size === 0) {
    throw new Error('CLIENT_TOKENS is empty — nothing could answer a request. Set at least one.');
  }
  // Overlapping tokens would let a compromised agent answer its own questions,
  // which defeats the entire point of a human-in-the-loop layer.
  for (const t of config.agentTokens) {
    if (config.clientTokens.has(t)) {
      throw new Error('A token appears in both AGENT_TOKENS and CLIENT_TOKENS. Keep them distinct.');
    }
  }
}

export { required };
