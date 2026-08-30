/**
 * Speech to text: turning what the human said back into something an agent can
 * read.
 *
 * Three backends, chosen by `STT_PROVIDER`, because which one is actually best
 * here cannot be settled from a datasheet — it depends on the phone's recogniser
 * quality, the NAS's spare cycles, and how much latency is tolerable mid-call:
 *
 *   device  — the phone already transcribed it. Nothing to do here but accept
 *             the text. No latency, no cost, no audio leaves the handset.
 *   whisper — a self-hosted Whisper speaking the OpenAI transcription API
 *             (whisper-asr-webservice, faster-whisper-server, whisper.cpp's
 *             server all do). Audio stays on the LAN.
 *   cloud   — a hosted transcription API. Best accuracy, costs money, and the
 *             recording leaves the building. Off by default for that reason.
 *
 * `whisper` and `cloud` share a request shape, which is the whole reason for
 * picking an OpenAI-compatible endpoint: the difference between "my NAS" and
 * "someone's API" collapses to a base URL and whether there is a key.
 */

import { config } from './config.ts';

export type SttProvider = 'device' | 'whisper' | 'cloud';

export interface Transcript {
  text: string;
  /** Which backend produced it. Recorded so a bad turn can be attributed. */
  provider: SttProvider;
  /** Wall-clock cost of the transcription itself, for tuning. */
  ms: number;
}

export class SttError extends Error {}

/** True if audio sent to this server can be transcribed at all. */
export function sttEnabled(): boolean {
  const p = config.stt.provider;
  if (p === 'device') return false;
  if (p === 'whisper') return Boolean(config.stt.whisperUrl);
  return Boolean(config.stt.cloudApiKey);
}

/**
 * Transcribe an utterance.
 *
 * `deviceText` is what the phone's own recogniser heard, if anything. Under the
 * `device` provider it is the answer outright. Under the others it is still
 * worth passing: if the upload or the model fails, a slightly worse transcript
 * beats dropping the human's turn on the floor and asking them to repeat.
 */
export async function transcribe(
  audio: Uint8Array | null,
  deviceText: string | null,
  mimeType = 'audio/mp4',
): Promise<Transcript> {
  const started = Date.now();
  const provider = config.stt.provider;

  if (provider === 'device' || !audio || audio.byteLength === 0) {
    const text = (deviceText ?? '').trim();
    if (!text) throw new SttError('No speech to transcribe.');
    return { text, provider: 'device', ms: Date.now() - started };
  }

  try {
    const text = await remoteTranscribe(audio, mimeType);
    return { text, provider, ms: Date.now() - started };
  } catch (err) {
    const fallback = (deviceText ?? '').trim();
    if (!fallback) throw err instanceof SttError ? err : new SttError(String(err));
    // Losing the better transcript is a quality problem. Losing the turn is a
    // broken call, and the human has to say it all again.
    return { text: fallback, provider: 'device', ms: Date.now() - started };
  }
}

async function remoteTranscribe(audio: Uint8Array, mimeType: string): Promise<string> {
  const { provider, whisperUrl, cloudUrl, cloudApiKey, model, language, timeoutMs } = config.stt;

  const base = provider === 'whisper' ? whisperUrl : cloudUrl;
  if (!base) throw new SttError(`STT_PROVIDER=${provider} but no endpoint is configured.`);

  const form = new FormData();
  // Node's FormData needs a real Blob for the file part; a bare Uint8Array is
  // silently serialised as a string field and the server sees no audio.
  form.append('file', new Blob([audio], { type: mimeType }), utteranceName(mimeType));
  form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  const headers: Record<string, string> = {};
  if (provider === 'cloud' && cloudApiKey) headers.Authorization = `Bearer ${cloudApiKey}`;

  const res = await fetch(`${base.replace(/\/+$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err) => {
    throw new SttError(`Transcription request failed: ${(err as Error).message}`);
  });

  if (!res.ok) {
    throw new SttError(`Transcription failed: ${res.status} ${await res.text().catch(() => '')}`);
  }

  const body = (await res.json().catch(() => null)) as { text?: string } | null;
  const text = body?.text?.trim();
  if (!text) throw new SttError('Transcription returned no text.');
  return text;
}

/** Whisper endpoints route on the extension, so it has to look like the codec. */
function utteranceName(mimeType: string): string {
  if (mimeType.includes('wav')) return 'utterance.wav';
  if (mimeType.includes('ogg') || mimeType.includes('opus')) return 'utterance.ogg';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'utterance.mp3';
  return 'utterance.m4a';
}
