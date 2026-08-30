/**
 * Calls: a spoken message that rings through and is kept for replay.
 *
 * ## What "call" means here, honestly
 *
 * Stage 1 is not PSTN telephony. There is no carrier, no SIP trunk, no phone
 * number. A call is: render the message to speech, push it at maximum priority
 * so it breaks through Do Not Disturb, attach the recording, and keep that
 * recording permanently so it can be replayed later.
 *
 * That is deliberately the useful 80%. The thing that makes a phone call work
 * as a reminder is not the dial tone — it is that it arrives loudly, says
 * something, and can be listened to again afterwards. Stages 2 and 3 (a live
 * two-way call, and the user calling in) need the Android app and a real audio
 * transport; the recording model here is what they will be built on top of,
 * not something they replace.
 *
 * ## Why the recording is kept
 *
 * A voice rendering of a notification is disposable — the text says the same
 * thing. A call recording is not: it is the only artefact of the call. So it is
 * stored with `keep`, which exempts it from the 48h audio pruner.
 */

import * as callsession from './callsession.ts';
import { config } from './config.ts';
import { pushEnabled } from './push.ts';
import * as requests from './requests.ts';
import { synthesize, voiceEnabled } from './voice.ts';
import type { CallSession, Priority, TetherRequest } from './types.ts';

export interface PlaceCallArgs {
  /** What to say. Fish `[bracket]` delivery markers are passed through. */
  text: string;
  title?: string;
  priority?: Priority;
  /** Optional answer buttons, if the call also asks something. */
  choices?: string[] | null;
  context?: Record<string, unknown> | null;
  agentName?: string;
  /** Override the configured voice for this call only. */
  referenceId?: string;
  speed?: number;
  timeoutSec?: number;
}

export interface CallResult {
  request: TetherRequest;
  /** Null when TTS was unavailable — the call still went out, as text. */
  audioId: string | null;
  /** The ringing session, when the Android app transport is configured. */
  session: CallSession | null;
}

export async function placeCall(a: PlaceCallArgs): Promise<CallResult> {
  const audioId = await synthesize(a.text, {
    referenceId: a.referenceId,
    speed: a.speed,
    // The recording IS the call. It outlives the audio cache.
    keep: true,
  });

  if (!audioId && voiceEnabled()) {
    console.warn('[tether] call TTS failed; delivering the message as text');
  }

  const request = requests.create({
    kind: 'call',
    title: a.title || 'Call',
    body: a.text,
    choices: a.choices ?? null,
    context: a.context ?? null,
    // A call is the loudest thing Tether can do. Anything quieter should have
    // been a notification.
    priority: a.priority ?? 'urgent',
    audioId,
    agentName: a.agentName ?? 'agent',
    // With choices it is a real question; without, it is an announcement that
    // settles on its own like `notify` does.
    timeoutSec: a.timeoutSec ?? (a.choices?.length ? config.defaultTimeoutSec : 300),
  });

  // Ring the paired devices. Without FCM configured there is nothing to ring,
  // and the call degrades to what stage 1 always was: a max-priority message
  // with a recording attached, delivered by the fan-out channels.
  let session: CallSession | null = null;
  if (pushEnabled()) {
    try {
      session = await callsession.ring(request);
    } catch (err) {
      console.error('[tether] could not ring devices:', (err as Error).message);
    }
  }

  return { request, audioId, session };
}
