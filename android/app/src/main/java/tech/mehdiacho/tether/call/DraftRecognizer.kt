package tech.mehdiacho.tether.call

import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import java.io.OutputStream
import java.util.concurrent.LinkedBlockingQueue

/**
 * A running transcript of what the caller is saying, produced while they say it.
 *
 * ## The trick, and why it is the whole class
 *
 * The obvious way to get a live draft is to hand [SpeechRecognizer] the
 * microphone. That cannot work here: the recorder already has it, and Android
 * gives the microphone to one client at a time. Running both means one of them
 * silently gets nothing.
 *
 * So the recogniser is never allowed near the microphone. It is handed the read
 * end of a pipe via `EXTRA_AUDIO_SOURCE` and fed the same PCM the recorder is
 * already keeping. There is exactly one microphone client — the recorder — and
 * the draft is a consumer of its bytes rather than a competitor for its
 * hardware. That also makes this class orthogonal to call audio routing:
 * whatever the recorder settles about Bluetooth, echo cancellation or
 * communication mode, the draft rides along on the resulting samples unchanged.
 *
 * Android 13 is where `EXTRA_AUDIO_SOURCE` arrives. Below it there is no draft,
 * only the upload — see [isSupported]. A missing draft is a downgrade; a missing
 * recording would be a broken call, which is why feeding can never block the
 * recorder (see [feed]).
 */
class DraftRecognizer(private val context: Context) {

    /** Latest partial or final text. Read by the UI while speech is in flight. */
    @Volatile
    var text: String = ""
        private set

    private var recognizer: SpeechRecognizer? = null
    private var sink: OutputStream? = null
    private var writer: Thread? = null
    private val queue = LinkedBlockingQueue<ByteArray>(QUEUE_FRAMES)
    private var onText: (String) -> Unit = {}

    /**
     * Start listening to the pipe. Returns false if a draft is not available,
     * which is not an error — the caller carries on recording without one.
     */
    fun start(onText: (String) -> Unit): Boolean {
        if (!isSupported(context)) {
            Log.i(
                TAG,
                "no draft: sdk=${Build.VERSION.SDK_INT} " +
                    "recognition=${SpeechRecognizer.isRecognitionAvailable(context)} " +
                    "onDevice=${onDeviceAvailable(context)}",
            )
            return false
        }
        this.onText = onText

        val pipe = runCatching { ParcelFileDescriptor.createPipe() }.getOrElse {
            Log.w(TAG, "no pipe: ${it.message}")
            return false
        }

        sink = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
        writer = Thread(::drain, "tether-draft-writer").apply {
            isDaemon = true
            start()
        }

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0])
            putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
            putExtra(
                RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, SAMPLE_RATE)
            putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
        }

        // On-device by preference. `EXTRA_AUDIO_SOURCE` is a contract with the
        // recogniser about where its samples come from, and the on-device
        // service is the one that actually honours it — a cloud-backed default
        // will accept the intent and then quietly transcribe nothing.
        val ok = runCatching {
            val r =
                if (onDeviceAvailable(context)) SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                else SpeechRecognizer.createSpeechRecognizer(context)
            r.setRecognitionListener(listener)
            r.startListening(intent)
            recognizer = r
            Log.i(TAG, "draft started (onDevice=${onDeviceAvailable(context)})")
        }.onFailure { Log.w(TAG, "recogniser would not start: ${it.message}") }.isSuccess

        if (!ok) release()
        return ok
    }

    /**
     * Hand the recogniser a frame the recorder has already kept.
     *
     * Never blocks, and drops the oldest frame rather than waiting on a stalled
     * recogniser. The rule this encodes: draft audio is expendable, recorded
     * audio is not. A recorder that stalls behind a transcriber loses the actual
     * words of the call to save a preview of them.
     */
    fun feed(frame: ByteArray) {
        if (sink == null) return
        if (!queue.offer(frame)) {
            queue.poll()
            queue.offer(frame)
        }
    }

    /**
     * Stop feeding and let the recogniser flush.
     *
     * Closing the pipe is the only "they stopped talking" signal the recogniser
     * gets — it cannot hear the silence, because silence is exactly what stops
     * being written. So the poison pill is what turns the last partial into a
     * final result.
     */
    fun stop() {
        if (sink != null) queue.offer(ByteArray(0))
        runCatching { writer?.join(WRITER_JOIN_MS) }
        writer = null
    }

    /** Tear down for good. Safe to call twice, and safe without [start]. */
    fun release() {
        stop()
        runCatching { recognizer?.destroy() }
        recognizer = null
        runCatching { sink?.close() }
        sink = null
        queue.clear()
    }

    private fun drain() {
        val out = sink ?: return
        var written = 0
        while (true) {
            val frame = runCatching { queue.take() }.getOrNull() ?: break
            if (frame.isEmpty()) break
            if (runCatching { out.write(frame) }.isFailure) break
            written += frame.size
        }
        runCatching { out.flush() }
        runCatching { out.close() }
        Log.d(TAG, "fed $written bytes to the recogniser")
    }

    private val listener = object : RecognitionListener {
        override fun onPartialResults(results: Bundle) = publish(results)
        override fun onResults(results: Bundle) = publish(results)
        override fun onSegmentResults(results: Bundle) = publish(results)

        override fun onError(error: Int) {
            // Non-fatal by construction: whatever draft exists survives and the
            // recording is untouched. No draft is never worse than no recording.
            Log.i(TAG, "draft error $error; keeping ${text.length} chars")
        }

        override fun onReadyForSpeech(params: Bundle?) { Log.d(TAG, "ready") }
        override fun onBeginningOfSpeech() { Log.d(TAG, "speech began") }
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() { Log.d(TAG, "speech ended") }
        override fun onEndOfSegmentedSession() { Log.d(TAG, "segments done") }
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
    }

    private fun publish(results: Bundle) {
        val best = results
            .getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.trim()
            .orEmpty()

        // Segments arrive as separate results, and a later one can be shorter
        // than what came before it. Longest wins, so the draft only ever grows.
        if (best.length <= text.length) return
        text = best
        runCatching { onText(best) }
    }

    companion object {
        private const val TAG = "TetherDraft"

        /** ~5 seconds of 20 ms frames. Past that the recogniser is not keeping up. */
        private const val QUEUE_FRAMES = 256
        private const val WRITER_JOIN_MS = 1_500L

        const val SAMPLE_RATE = 16_000

        /**
         * `EXTRA_AUDIO_SOURCE` is Android 13. Without it a recogniser can only be
         * given the microphone, which the recorder already holds — so on older
         * phones there is no draft at all, rather than a fight over the mic.
         */
        fun isSupported(context: Context): Boolean =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                (SpeechRecognizer.isRecognitionAvailable(context) || onDeviceAvailable(context))

        private fun onDeviceAvailable(context: Context): Boolean =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                runCatching { SpeechRecognizer.isOnDeviceRecognitionAvailable(context) }
                    .getOrDefault(false)
    }
}
