/**
 * Fish Audio text-to-speech.
 *
 * Voice lives on the server, not the phone, for two reasons: the API key never
 * leaves the host, and every client (phone, web, call playback) gets the same
 * voice without each one needing credentials.
 *
 * Voice is always optional. If Fish is unconfigured or fails, the caller still
 * gets a perfectly good text notification — a failed TTS must never swallow
 * the message itself.
 *
 * ## Emotion and delivery markers
 *
 * The s2.x models accept free-form natural-language cues in SQUARE brackets,
 * inline, anywhere in the text:
 *
 *     "[cheerful] The build passed. [pause] All forty tests green."
 *
 * They are open-domain rather than a fixed enum, so "[sounding slightly
 * concerned]" works as well as "[worried]". The older s1 model used
 * (parentheses) and a fixed tag set instead — worth knowing if the model is
 * ever changed. Markers are passed through untouched; we do not validate them,
 * because the valid set is effectively unbounded.
 */

import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { putAudio } from './db.ts';

export function voiceEnabled(): boolean {
  return Boolean(config.fish.apiKey);
}

/* --------------------------------------------------------------- lead-in -- */

/**
 * One silent MPEG-1 Layer III frame: 128 kbps, 44.1 kHz, mono. 417 bytes,
 * 1152 samples, 26.12 ms.
 *
 * WHY THIS EXISTS. Fish returns audio whose speech begins ~50 ms in. That is
 * technically correct and practically wrong: an idle audio endpoint (Windows
 * WASAPI, an Android speaker waking, a browser starting a stream) takes a few
 * hundred milliseconds to actually produce sound, and it eats whatever was
 * playing meanwhile. The result is a message that starts mid-word — "night the
 * experiment holds" instead of "Tonight the experiment holds".
 *
 * Measured, not guessed: `silencedetect` on raw Fish output reports
 * `silence_start: 0 / silence_end: 0.051`, and speech is at full RMS by 100 ms.
 *
 * The fix is silence at the head of the file, so the device has something
 * disposable to swallow. Prepending whole MPEG frames is a pure byte
 * concatenation — MP3 frames are self-contained, so no decoder, no ffmpeg, and
 * no runtime dependency is involved.
 */
const SILENT_FRAME_B64 =
  '//uQxAADwAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';

const SILENT_FRAME = Buffer.from(SILENT_FRAME_B64, 'base64');
const FRAME_MS = (1152 / 44_100) * 1000; // 26.122 ms

/** Bitrate table for MPEG-1 Layer III, indexed by the header's bitrate bits. */
const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SAMPLE_RATES = [44_100, 48_000, 32_000];

interface FrameHeader {
  bitrateKbps: number;
  sampleRate: number;
  mono: boolean;
}

/**
 * Parse the first MPEG audio frame header. Returns null if the bytes are not a
 * plain MPEG-1 Layer III frame — including the case where the file opens with
 * an ID3 tag, which we deliberately refuse to handle rather than guess at.
 */
function readFrameHeader(buf: Uint8Array): FrameHeader | null {
  if (buf.length < 4) return null;
  // Frame sync: 11 set bits, then MPEG-1 (11) and Layer III (01).
  if (buf[0] !== 0xff) return null;
  const b1 = buf[1]!;
  if ((b1 & 0xe0) !== 0xe0) return null;
  if (((b1 >> 3) & 0x03) !== 0x03) return null; // MPEG version 1
  if (((b1 >> 1) & 0x03) !== 0x01) return null; // Layer III

  const b2 = buf[2]!;
  const bitrateKbps = BITRATES[(b2 >> 4) & 0x0f] ?? 0;
  const sampleRate = SAMPLE_RATES[(b2 >> 2) & 0x03] ?? 0;
  if (!bitrateKbps || !sampleRate) return null;

  // Channel mode 3 == single channel (mono).
  const mono = ((buf[3]! >> 6) & 0x03) === 0x03;
  return { bitrateKbps, sampleRate, mono };
}

/**
 * Prepend silence, but only when the incoming audio matches the silent frame's
 * format exactly. Splicing a 44.1 kHz mono frame onto a 48 kHz stereo stream
 * would produce a click or a decode glitch, and a slightly clipped message is
 * a much better failure than a corrupted one.
 */
export function withLeadIn(mp3: Uint8Array, leadInMs = config.voice.leadInMs): Uint8Array {
  if (leadInMs <= 0) return mp3;

  const header = readFrameHeader(mp3);
  if (!header) {
    console.warn('[tether] TTS audio is not a bare MPEG-1 LIII stream; skipping lead-in');
    return mp3;
  }
  if (header.bitrateKbps !== 128 || header.sampleRate !== 44_100 || !header.mono) {
    console.warn(
      `[tether] TTS audio is ${header.bitrateKbps}kbps/${header.sampleRate}Hz/` +
        `${header.mono ? 'mono' : 'stereo'}; lead-in frame does not match, skipping`,
    );
    return mp3;
  }

  const frames = Math.max(1, Math.round(leadInMs / FRAME_MS));
  const out = Buffer.allocUnsafe(SILENT_FRAME.length * frames + mp3.length);
  for (let i = 0; i < frames; i++) SILENT_FRAME.copy(out, i * SILENT_FRAME.length);
  Buffer.from(mp3).copy(out, SILENT_FRAME.length * frames);
  return out;
}

/* ------------------------------------------------------------ synthesise -- */

export interface SynthOptions {
  /** Fish voice model id. Falls back to the server's configured default. */
  referenceId?: string;
  /** 0.5–2.0 speed multiplier. Slower reads better over a phone speaker. */
  speed?: number;
  /** Milliseconds of silence to prepend. Defaults to the configured value. */
  leadInMs?: number;
  /**
   * Exempt this audio from the 48h pruner. Set for call recordings, which are
   * the only artefact of the call rather than a re-renderable convenience.
   */
  keep?: boolean;
}

/**
 * Render text to speech and store it. Returns the audio id, or null if voice
 * is unavailable — callers treat null as "send it as text only".
 */
export async function synthesize(
  text: string,
  opts: SynthOptions = {},
): Promise<string | null> {
  if (!config.fish.apiKey) return null;

  const referenceId = opts.referenceId || config.fish.referenceId || undefined;

  const body: Record<string, unknown> = {
    text,
    format: 'mp3',
    mp3_bitrate: 128,
    // Pinned so the lead-in frame always matches; see withLeadIn.
    sample_rate: 44_100,
    temperature: config.voice.temperature,
    top_p: config.voice.topP,
    prosody: {
      speed: opts.speed ?? config.voice.speed,
      volume: 0,
      normalize_loudness: true,
    },
  };
  if (referenceId) body['reference_id'] = referenceId;

  try {
    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.fish.apiKey}`,
        'Content-Type': 'application/json',
        model: config.fish.model,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      console.error(`[tether] Fish TTS ${res.status}: ${await res.text().catch(() => '')}`);
      return null;
    }

    const raw = new Uint8Array(await res.arrayBuffer());
    if (raw.byteLength === 0) {
      console.error('[tether] Fish TTS returned an empty body');
      return null;
    }

    const bytes = withLeadIn(raw, opts.leadInMs);
    const id = randomUUID();
    putAudio(id, 'audio/mpeg', bytes, opts.keep ?? false);
    return id;
  } catch (err) {
    console.error('[tether] Fish TTS failed:', err);
    return null;
  }
}
