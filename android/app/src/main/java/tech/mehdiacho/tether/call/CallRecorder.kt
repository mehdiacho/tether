package tech.mehdiacho.tether.call

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The caller's half of the conversation: one utterance, captured, endpointed and
 * handed back as WAV plus whatever the phone managed to transcribe live.
 *
 * ## One microphone client, two consumers
 *
 * Exactly one thing here opens the microphone: [AudioRecord]. Every 20 ms frame
 * it produces goes two places — into the WAV buffer that will be uploaded, and
 * into [DraftRecognizer], which is fed through a pipe rather than being given
 * the microphone itself. That is what allows an instant on-screen draft and an
 * accurate server-side transcript from the same breath, instead of having to
 * pick one.
 *
 * ## Recording during a call is not recording
 *
 * The agent's voice is coming out of the same earbuds this is recording into, so
 * `VOICE_COMMUNICATION` rather than `MIC` — it is the source the platform
 * applies echo cancellation and noise suppression to, and on a Bluetooth headset
 * it is the one that reads the headset's own microphone rather than the phone's.
 * The effects are then attached explicitly as well, because plenty of devices
 * expose them without applying them by default.
 *
 * ## Knowing when they stopped
 *
 * There is no platform callback for this that works on a pipe, so silence is
 * measured directly. The noise floor is learned from the first few hundred
 * milliseconds rather than assumed, because a car at 100 km/h and a quiet room
 * are two orders of magnitude apart and a fixed threshold would either never
 * trigger in one or trigger constantly in the other.
 */
class CallRecorder(private val context: Context) {

    /**
     * What one turn of speech produced.
     *
     * [draft] may be empty — an older phone, an unavailable recogniser, or a
     * recogniser that errored. The [wav] is the part that must always be there.
     */
    data class Utterance(val wav: ByteArray, val draft: String) {
        val durationMs: Int get() = ((wav.size - WAV_HEADER_BYTES).coerceAtLeast(0)) / BYTES_PER_MS

        // Data class equality on a ByteArray compares references, which is
        // never what anyone means. Overridden so the warning is not just muted.
        override fun equals(other: Any?): Boolean =
            this === other || (other is Utterance && wav.contentEquals(other.wav) && draft == other.draft)

        override fun hashCode(): Int = 31 * wav.contentHashCode() + draft.hashCode()
    }

    /** Set by the platform when another app takes the microphone. See [watchForSilencing]. */
    @Volatile
    private var silenced = false

    /**
     * Record until the caller stops talking, then return what they said.
     *
     * Returns null when there is nothing worth sending: no permission, no
     * microphone, nobody spoke, or the platform silenced the stream. All four
     * mean the same thing to the call — hold the line, do not post a turn.
     */
    @SuppressLint("MissingPermission") // Checked by hasPermission below.
    suspend fun listen(onDraft: (String) -> Unit): Utterance? = withContext(Dispatchers.IO) {
        if (!hasPermission(context)) {
            Log.i(TAG, "no RECORD_AUDIO; the call stays one-way")
            return@withContext null
        }

        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        if (minBuffer <= 0) {
            Log.w(TAG, "no usable capture buffer ($minBuffer)")
            return@withContext null
        }

        val recorder = runCatching {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE,
                CHANNEL,
                ENCODING,
                maxOf(minBuffer, FRAME_BYTES * 8),
            )
        }.getOrElse {
            Log.w(TAG, "could not open the microphone: ${it.message}")
            return@withContext null
        }

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            runCatching { recorder.release() }
            Log.w(TAG, "microphone did not initialise")
            return@withContext null
        }

        val effects = attachEffects(recorder.audioSessionId)
        val draft = DraftRecognizer(context)
        val started = draft.start(onDraft)
        silenced = false
        val watcher = watchForSilencing(recorder.audioSessionId)

        try {
            recorder.startRecording()
            val pcm = capture(recorder, draft)
            draft.stop()

            if (pcm == null) return@withContext null
            Utterance(wav(pcm), if (started) draft.text else "")
        } catch (err: IllegalStateException) {
            Log.w(TAG, "capture failed: ${err.message}")
            null
        } finally {
            runCatching { recorder.stop() }
            runCatching { recorder.release() }
            watcher?.let { runCatching { audioManager()?.unregisterAudioRecordingCallback(it) } }
            effects.forEach { runCatching { it.release() } }
            draft.release()
        }
    }

    /**
     * The capture loop. Returns the raw PCM, or null if nothing was said.
     *
     * Every frame is written whether or not it is speech: keeping the run-up
     * costs a few kilobytes of near-silence and avoids the far worse failure of
     * clipping the first syllable, which is the one a transcriber most needs.
     */
    private suspend fun capture(recorder: AudioRecord, draft: DraftRecognizer): ByteArray? {
        val pcm = ByteArrayOutputStream(SAMPLE_RATE * 2 * 4)
        val frame = ByteArray(FRAME_BYTES)

        var elapsedMs = 0
        var speechMs = 0
        var silenceMs = 0
        var speaking = false
        var floor = 0.0
        var floorFrames = 0

        while (currentCoroutineContext().isActive) {
            val read = recorder.read(frame, 0, FRAME_BYTES)
            if (read <= 0) {
                Log.w(TAG, "read returned $read; stopping")
                break
            }

            // A silenced stream still delivers perfectly-shaped frames of
            // nothing. Without this check the result is a plausible recording of
            // absolute silence and no clue as to why.
            if (silenced) {
                Log.i(TAG, "microphone taken by another app; abandoning the turn")
                return null
            }

            pcm.write(frame, 0, read)
            draft.feed(frame.copyOf(read))

            val level = rms(frame, read)
            elapsedMs += FRAME_MS

            if (floorFrames < CALIBRATE_FRAMES) {
                floor = (floor * floorFrames + level) / (floorFrames + 1)
                floorFrames++
                continue
            }

            val threshold = maxOf(floor * SPEECH_FACTOR, MIN_SPEECH_RMS)

            if (level > threshold) {
                speechMs += FRAME_MS
                silenceMs = 0
                if (speechMs >= MIN_SPEECH_MS) speaking = true
            } else {
                if (speaking) silenceMs += FRAME_MS
                // Track the room, not the speaker: a floor learned once at the
                // start goes stale the moment a car window opens.
                else floor = floor * (1 - FLOOR_DECAY) + level * FLOOR_DECAY
            }

            if (speaking && silenceMs >= HANGOVER_MS) break
            if (speaking && elapsedMs >= MAX_UTTERANCE_MS) {
                Log.i(TAG, "utterance hit the ceiling; sending what there is")
                break
            }
            if (!speaking && elapsedMs >= NO_SPEECH_TIMEOUT_MS) {
                Log.i(TAG, "nobody said anything")
                return null
            }
        }

        return if (speaking) pcm.toByteArray() else null
    }

    /**
     * Echo cancellation and noise suppression, where the device has them.
     *
     * `VOICE_COMMUNICATION` is supposed to imply both, and on many devices does.
     * On many others it does not, and the agent's own voice comes back in the
     * recording loud enough to be transcribed as if the caller had said it.
     */
    private fun attachEffects(sessionId: Int): List<android.media.audiofx.AudioEffect> {
        val effects = mutableListOf<android.media.audiofx.AudioEffect>()

        if (AcousticEchoCanceler.isAvailable()) {
            runCatching { AcousticEchoCanceler.create(sessionId) }
                .getOrNull()
                ?.also { it.enabled = true; effects += it }
        }
        if (NoiseSuppressor.isAvailable()) {
            runCatching { NoiseSuppressor.create(sessionId) }
                .getOrNull()
                ?.also { it.enabled = true; effects += it }
        }
        return effects
    }

    /**
     * Notice when the platform mutes this stream.
     *
     * Android does not stop the recorder or raise an error when another app
     * takes the microphone — it keeps handing over frames of digital silence.
     * The only way to tell is to ask.
     */
    private fun watchForSilencing(sessionId: Int): AudioManager.AudioRecordingCallback? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val am = audioManager() ?: return null

        val callback = object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                val mine = configs.firstOrNull { it.clientAudioSessionId == sessionId } ?: return
                if (mine.isClientSilenced) silenced = true
            }
        }
        runCatching { am.registerAudioRecordingCallback(callback, null) }
        return callback
    }

    private fun audioManager(): AudioManager? = context.getSystemService(AudioManager::class.java)

    /** Root-mean-square amplitude of one frame, on the 16-bit sample scale. */
    private fun rms(frame: ByteArray, length: Int): Double {
        var sum = 0.0
        var i = 0
        while (i + 1 < length) {
            val sample = (frame[i].toInt() and 0xFF) or (frame[i + 1].toInt() shl 8)
            val value = sample.toShort().toDouble()
            sum += value * value
            i += 2
        }
        val samples = length / 2
        return if (samples == 0) 0.0 else kotlin.math.sqrt(sum / samples)
    }

    /**
     * Wrap raw PCM in a WAV header.
     *
     * No encoder: at 32 KB/s a ten-second turn is 320 KB, which is nothing over
     * a LAN, and every transcription endpoint takes WAV without argument. An
     * encoder here would buy bandwidth nobody is short of at the price of a
     * codec that can fail.
     */
    private fun wav(pcm: ByteArray): ByteArray {
        val header = ByteBuffer.allocate(WAV_HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        val byteRate = SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE / 8

        header.put("RIFF".toByteArray())
        header.putInt(36 + pcm.size)
        header.put("WAVE".toByteArray())
        header.put("fmt ".toByteArray())
        header.putInt(16)               // PCM header length
        header.putShort(1)              // format: uncompressed PCM
        header.putShort(CHANNELS.toShort())
        header.putInt(SAMPLE_RATE)
        header.putInt(byteRate)
        header.putShort((CHANNELS * BITS_PER_SAMPLE / 8).toShort())
        header.putShort(BITS_PER_SAMPLE.toShort())
        header.put("data".toByteArray())
        header.putInt(pcm.size)

        return header.array() + pcm
    }

    companion object {
        private const val TAG = "TetherRecorder"

        private const val SAMPLE_RATE = DraftRecognizer.SAMPLE_RATE
        private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
        private const val CHANNELS = 1
        private const val BITS_PER_SAMPLE = 16

        /** 20 ms at 16 kHz mono 16-bit. Small enough that a draft feels live. */
        private const val FRAME_MS = 20
        private const val FRAME_BYTES = SAMPLE_RATE * 2 * FRAME_MS / 1000
        private const val BYTES_PER_MS = SAMPLE_RATE * 2 / 1000
        const val WAV_HEADER_BYTES = 44

        const val MIME_TYPE = "audio/wav"

        /** How much of the start is spent learning the room rather than judging it. */
        private const val CALIBRATE_FRAMES = 400 / FRAME_MS

        /** Speech is this much louder than the room it is spoken in. */
        private const val SPEECH_FACTOR = 3.0

        /** A floor beneath which a "quiet room" is really a dead microphone. */
        private const val MIN_SPEECH_RMS = 450.0

        /** How fast the floor follows a room that changes while nobody is talking. */
        private const val FLOOR_DECAY = 0.05

        /** Long enough that a cough or a door is not mistaken for an answer. */
        private const val MIN_SPEECH_MS = 240

        /**
         * Silence that ends a turn. Short enough not to feel like waiting, long
         * enough to survive the pause in the middle of a sentence — the failure
         * everyone has had from a voice assistant that cut them off at a comma.
         */
        private const val HANGOVER_MS = 1_100

        /** Nobody spoke at all: hold the line rather than posting an empty turn. */
        private const val NO_SPEECH_TIMEOUT_MS = 8_000

        /** A ceiling, not a target. Something is wrong past this. */
        private const val MAX_UTTERANCE_MS = 45_000

        fun hasPermission(context: Context): Boolean =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
    }
}
