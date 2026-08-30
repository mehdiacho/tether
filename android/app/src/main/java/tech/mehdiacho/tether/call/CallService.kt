package tech.mehdiacho.tether.call

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import tech.mehdiacho.tether.data.IncomingCall
import tech.mehdiacho.tether.data.TetherClient
import java.io.File

/**
 * Everything audible about a call: the ringtone, the vibration, and the agent's
 * speech once it is answered.
 *
 * This is a foreground service rather than work started from the Activity
 * because a call has to survive the ringing screen being dismissed, the phone
 * being rotated, and the user tapping Answer from the notification shade
 * without ever opening the app. The Activity is a view; this is the call.
 */
class CallService : Service() {

    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private lateinit var notifier: CallNotifier
    private lateinit var client: TetherClient
    private lateinit var recorder: CallRecorder

    private var ringer: MediaPlayer? = null
    private var speech: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var focusRequest: AudioFocusRequest? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var ringTimeout: Job? = null
    /** Cancelled when the agent speaks again; fires when it does not. */
    private var holdOpen: Job? = null
    /** Distinguishes one turn's cached audio file from the next. */
    private var turnCount = 0

    private var current: IncomingCall? = null
    /** Sticky across the state machine so hang-up knows whether to notify the server. */
    private var answeredLocally = false
    /** Speakerphone toggle, so a route re-selection knows where to send the call. */
    private var speakerOn = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        notifier = CallNotifier(this)
        client = TetherClient(this)
        recorder = CallRecorder(this)
        vibrator = systemVibrator()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_RING -> {
                val call = intent.getBundleExtra(EXTRA_CALL)?.toIncomingCall()
                if (call == null) {
                    stopSelfSafely()
                } else {
                    startRinging(call)
                }
            }

            ACTION_ANSWER -> onAnswer()
            ACTION_TURN -> onTurn(
                intent.getStringExtra(EXTRA_CALL_ID).orEmpty(),
                intent.getStringExtra(EXTRA_AUDIO_URL).orEmpty(),
                intent.getStringExtra(EXTRA_TEXT).orEmpty(),
            )
            ACTION_DECLINE -> onDecline()
            ACTION_HANGUP -> onHangUp()
            ACTION_SPEAKER -> setSpeakerphone(intent.getBooleanExtra(EXTRA_SPEAKER_ON, false))
            ACTION_DISMISS -> onDismissedRemotely(
                intent.getStringExtra(EXTRA_CALL_ID).orEmpty(),
                intent.getStringExtra(EXTRA_REASON).orEmpty(),
            )

            else -> stopSelfSafely()
        }
        // Do not resurrect a call after the process dies. A phone that rings
        // for a call from twenty minutes ago is worse than one that misses it.
        return START_NOT_STICKY
    }

    /* -------------------------------------------------------------- ringing -- */

    private fun startRinging(call: IncomingCall) {
        // startForeground FIRST. The system gives only a few seconds after
        // startForegroundService before it kills the process for not calling it.
        // Media playback only, deliberately. Declaring the microphone type here
        // would ask for it while the phone is ringing in a pocket, which is both
        // a lie about what the service is doing and, on Android 14, a start the
        // system can refuse outright. The mic type is added when it is earned:
        // at answer, with the call on screen.
        ServiceCompat.startForeground(
            this,
            CallNotifier.CALL_NOTIFICATION_ID,
            notifier.ringing(call),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        )

        current = call
        answeredLocally = false
        CallController.publish(CallUiState.Ringing(call))

        acquireWakeLock(call.ringSeconds)
        startRingtone()
        startVibration()
        notifier.launchRingingScreen(call)

        ringTimeout?.cancel()
        ringTimeout = scope.launch {
            delay(call.ringSeconds * 1000L)
            // The server independently marks this missed; this is the local
            // half, so the phone stops ringing even if the "ended" push is lost.
            onDismissedRemotely(call.callId, "missed")
        }
    }

    private fun startRingtone() {
        stopRingtone()
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE) ?: return
        ringer = runCatching {
            MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                setDataSource(this@CallService, uri)
                isLooping = true
                prepare()
                start()
            }
        }.onFailure { Log.w(TAG, "ringtone failed: ${it.message}") }.getOrNull()
    }

    private fun stopRingtone() {
        ringer?.runCatching { stop(); release() }
        ringer = null
    }

    private fun startVibration() {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        runCatching {
            v.vibrate(VibrationEffect.createWaveform(RING_PATTERN, 0))
        }
    }

    private fun stopVibration() {
        runCatching { vibrator?.cancel() }
    }

    /* ------------------------------------------------------------ answering -- */

    private fun onAnswer() {
        val call = current ?: return stopSelfSafely()

        ringTimeout?.cancel()
        stopRingtone()
        stopVibration()
        answeredLocally = true
        // The ring-length wake lock was sized for a call nobody answered. This
        // one is answered, so it now has to outlive the ring window.
        acquireWakeLock(CONNECT_WAKE_SECONDS)

        CallController.publish(CallUiState.Connecting(call))
        notifier.update(notifier.ongoing(call, "Connecting…"))

        scope.launch {
            val result = client.answerCall(call.callId)

            result.onFailure { err ->
                // 409 is the expected outcome for every device that lost the
                // race. It is not an error worth showing.
                val lostRace = (err as? TetherClient.HttpError)?.code == 409
                Log.i(TAG, if (lostRace) "answered on another device" else "answer failed: ${err.message}")
                finish(if (lostRace) "Answered elsewhere" else "Could not connect")
            }

            result.onSuccess { segments ->
                // Fall back to the URL that came in the push if the server
                // returned none — a call that rang should still say its piece.
                val url = segments.firstOrNull()?.url ?: call.audioUrl
                val text = segments.firstOrNull()?.text ?: call.body

                if (url.isNullOrBlank()) {
                    // No audio at all: the agent's text is the whole message.
                    CallController.publish(CallUiState.Active(call, text, speaking = false))
                    notifier.update(notifier.ongoing(call, text))
                    delay(READ_TIME_MS)
                    holdLineOpen(call, text)
                } else {
                    playSpeech(call, url, text)
                }
            }
        }
    }

    /**
     * Fetch the speech to a cache file, then play it.
     *
     * Downloading first rather than streaming: the files are tens of kilobytes,
     * and a MediaPlayer buffering over a weak mobile connection produces
     * exactly the stuttering start that the server's silent lead-in exists to
     * prevent. A deterministic local file makes the lead-in do its job.
     */
    private suspend fun playSpeech(call: IncomingCall, url: String, text: String) {
        val bytes = client.fetchAudio(url).getOrElse { err ->
            Log.w(TAG, "audio fetch failed: ${err.message}")
            CallController.publish(CallUiState.Active(call, text, speaking = false))
            notifier.update(notifier.ongoing(call, text))
            delay(READ_TIME_MS)
            holdLineOpen(call, text)
            return
        }

        // Per turn, not per call: a second turn arriving would otherwise be
        // written over the file the first one is still playing.
        val file = File(cacheDir, "call-${call.callId}-${turnCount++}.mp3")
        runCatching { file.writeBytes(bytes) }.onFailure {
            Log.w(TAG, "could not cache audio: ${it.message}")
            hangUpAndFinish("Ended")
            return
        }

        requestAudioFocus()
        enterCallAudioMode()
        routeAudio()

        CallController.publish(CallUiState.Active(call, text, speaking = true))
        notifier.update(notifier.ongoing(call, text))

        stopSpeech()

        runCatching {
            speech = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        // VOICE_COMMUNICATION routes to the earpiece and ducks
                        // other audio the way a phone call does, which is the
                        // entire point of this being a call and not a clip.
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                setDataSource(file.absolutePath)
                setOnCompletionListener {
                    scope.launch { holdLineOpen(call, text) }
                }
                setOnErrorListener { _, what, extra ->
                    Log.w(TAG, "playback error $what/$extra")
                    scope.launch { hangUpAndFinish("Ended") }
                    true
                }
                prepare()
                start()
            }
        }.onFailure {
            Log.w(TAG, "could not play speech: ${it.message}")
            hangUpAndFinish("Ended")
        }
    }

    /**
     * The agent said something else on a call that is already up.
     *
     * A second turn is not a second call. The line, the audio focus and the
     * route are all already correct, so this only swaps what is playing —
     * which is the difference between a conversation and a voicemail.
     */
    private fun onTurn(callId: String, url: String, text: String) {
        val call = current ?: return
        if (callId.isNotEmpty() && call.callId != callId) return
        // A turn for a call this device never picked up is not ours to play.
        if (!answeredLocally) return

        holdOpen?.cancel()

        scope.launch {
            if (url.isBlank()) {
                CallController.publish(CallUiState.Active(call, text, speaking = false))
                notifier.update(notifier.ongoing(call, text))
                delay(READ_TIME_MS)
                holdLineOpen(call, text)
            } else {
                playSpeech(call, url, text)
            }
        }
    }

    /**
     * Keep the line up after the agent stops talking.
     *
     * The next turn arrives as a push, so the service has to still be alive to
     * receive it — hanging up the moment the audio ends makes a second turn
     * impossible by construction. The window is bounded because a silent agent
     * must not hold the audio route and the wake lock indefinitely; it matches
     * the server's own listen timeout, past which the agent has given up too.
     */
    private fun holdLineOpen(call: IncomingCall, spoken: String) {
        // Nothing is playing while the line is held, so without this the CPU is
        // free to sleep through the very push the hold exists to wait for.
        acquireWakeLock((HOLD_OPEN_MS / 1000).toInt())

        CallController.publish(CallUiState.Listening(call, spoken))
        notifier.update(notifier.ongoing(call, spoken))

        holdOpen?.cancel()
        holdOpen = scope.launch {
            captureReply(call, spoken)
            // Whether or not anything was said, the agent gets its window to
            // answer. Cancelled the moment it does — see onTurn.
            delay(HOLD_OPEN_MS)
            hangUpAndFinish("Ended")
        }
    }

    /**
     * Listen for the caller's answer and send it back.
     *
     * Runs inside the hold-open job on purpose: if the agent speaks again while
     * the microphone is open, cancelling that job closes the microphone, which
     * is what should happen when the other party starts talking.
     */
    private suspend fun captureReply(call: IncomingCall, spoken: String) {
        // The player still owns the output stream until it is told otherwise,
        // and recording underneath a live playback session is asking for the
        // agent's own voice back in the transcript.
        stopSpeech()

        if (!CallRecorder.hasPermission(this)) return
        if (!promoteToMicrophoneService()) return

        val utterance = recorder.listen { draft ->
            CallController.publish(CallUiState.Listening(call, spoken, draft))
        } ?: return

        CallController.publish(
            CallUiState.Listening(call, spoken, utterance.draft, thinking = true),
        )
        notifier.update(notifier.ongoing(call, "Thinking…"))

        client.postUtterance(
            call.callId,
            utterance.draft,
            utterance.wav,
            CallRecorder.MIME_TYPE,
        ).onFailure { Log.w(TAG, "utterance not delivered: ${it.message}") }
    }

    /**
     * Declare that this service is now using the microphone.
     *
     * Android 14 wants the type declared before the microphone is touched, and
     * will refuse the promotion if the app is not eligible — which is exactly
     * what happens if the call was answered from the shade with the screen
     * asleep. A refusal costs this turn its recording, not the call.
     */
    private fun promoteToMicrophoneService(): Boolean {
        val call = current ?: return false
        return runCatching {
            ServiceCompat.startForeground(
                this,
                CallNotifier.CALL_NOTIFICATION_ID,
                notifier.ongoing(call, "Listening…"),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        }.onFailure {
            Log.w(TAG, "microphone service type refused: ${it.message}")
        }.isSuccess
    }

    /** Route audio to the loudspeaker instead of the earpiece, mid-call. */
    fun setSpeakerphone(on: Boolean) {
        speakerOn = on
        scope.launch { routeAudio() }
    }

    /**
     * Send the call where a call should go.
     *
     * `MODE_IN_COMMUNICATION` on its own lands on the earpiece. Bluetooth
     * earbuds are not considered, because voice audio rides the headset profile
     * (SCO/HFP) and the platform will not engage it unless asked — while the
     * ringtone, being ordinary media, goes out over A2DP. That asymmetry is
     * exactly what it sounds like from the outside: it rings in your ears, you
     * answer, and the voice comes out of the phone.
     *
     * Preference order is what a phone call does — whatever the user has
     * actually put on, then the earpiece.
     */
    private suspend fun routeAudio() {
        val am = getSystemService(AudioManager::class.java) ?: return

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            legacyRouteAudio(am)
            return
        }

        val available = am.availableCommunicationDevices
        val wanted =
            if (speakerOn) available.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            else PREFERRED_ROUTES.firstNotNullOfOrNull { type ->
                available.firstOrNull { it.type == type }
            }

        if (wanted == null) return
        val ok = runCatching { am.setCommunicationDevice(wanted) }
            .onFailure { Log.w(TAG, "could not route to type ${wanted.type}: ${it.message}") }
            .getOrDefault(false)
        if (!ok) return

        // A Bluetooth headset link is not up the instant it is requested, and
        // anything played into it before it is takes the same exit as the first
        // word used to: silence. Wait for the route to actually be current.
        if (wanted.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
            wanted.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        ) {
            withTimeoutOrNull(ROUTE_SETTLE_TIMEOUT_MS) {
                while (am.communicationDevice?.id != wanted.id) delay(50)
            } ?: Log.w(TAG, "bluetooth route did not settle; playing anyway")
        }
    }

    @Suppress("DEPRECATION")
    private fun legacyRouteAudio(am: AudioManager) {
        runCatching {
            if (speakerOn) {
                am.stopBluetoothSco()
                am.isBluetoothScoOn = false
                am.isSpeakerphoneOn = true
            } else {
                am.isSpeakerphoneOn = false
                am.startBluetoothSco()
                am.isBluetoothScoOn = true
            }
        }
    }

    /* --------------------------------------------------------------- ending -- */

    private fun onDecline() {
        val call = current
        stopRingtone()
        stopVibration()
        ringTimeout?.cancel()
        if (call != null) {
            scope.launch { client.declineCall(call.callId) }
        }
        finish("Declined")
    }

    private fun onHangUp() {
        scope.launch { hangUpAndFinish("Ended") }
    }

    private suspend fun hangUpAndFinish(reason: String) {
        val call = current
        if (call != null && answeredLocally) {
            client.endCall(call.callId)
        }
        finish(reason)
    }

    /** The call ended somewhere other than this device. */
    private fun onDismissedRemotely(callId: String, reason: String) {
        val call = current
        // A late push for an older call must not kill a newer one.
        if (call != null && callId.isNotEmpty() && call.callId != callId) return

        val label = when (reason) {
            "answered" -> "Answered elsewhere"
            "declined" -> "Declined"
            "missed" -> "Missed"
            else -> "Ended"
        }
        finish(label)
    }

    private fun finish(reason: String) {
        val call = current
        ringTimeout?.cancel()
        holdOpen?.cancel()
        stopRingtone()
        stopVibration()
        stopSpeech()
        abandonAudioFocus()
        leaveCallAudioMode()
        releaseWakeLock()

        if (call != null) {
            CallController.publish(CallUiState.Ended(call, reason))
            // A missed or declined call still deserves a trace in the shade.
            notifier.showCallOver(call, reason)
        } else {
            CallController.publish(CallUiState.Idle)
        }
        current = null
        stopSelfSafely()
    }

    private fun stopSpeech() {
        speech?.runCatching { stop(); release() }
        speech = null
    }

    private fun stopSelfSafely() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /* ---------------------------------------------------------------- audio -- */

    private fun requestAudioFocus() {
        val am = getSystemService(AudioManager::class.java) ?: return
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // EXCLUSIVE, not TRANSIENT: nothing should duck under a call and
            // keep playing. Music pauses outright, as it would for a real one.
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                .setAudioAttributes(attrs)
                .build()
            focusRequest = request
            am.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(
                null,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
            )
        }
    }

    private fun abandonAudioFocus() {
        val am = getSystemService(AudioManager::class.java) ?: return
        val request = focusRequest
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && request != null) {
            am.abandonAudioFocusRequest(request)
        } else {
            @Suppress("DEPRECATION")
            am.abandonAudioFocus(null)
        }
        focusRequest = null
    }

    private fun enterCallAudioMode() {
        val am = getSystemService(AudioManager::class.java) ?: return
        runCatching { am.mode = AudioManager.MODE_IN_COMMUNICATION }
    }

    private fun leaveCallAudioMode() {
        val am = getSystemService(AudioManager::class.java) ?: return
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                am.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                am.stopBluetoothSco()
                @Suppress("DEPRECATION")
                am.isBluetoothScoOn = false
            }
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = false
            am.mode = AudioManager.MODE_NORMAL
        }
        speakerOn = false
    }

    private fun systemVibrator(): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Vibrator::class.java)
        }

    /**
     * Hold the CPU awake for the ring window.
     *
     * A push can arrive with the device deep in Doze; without this the process
     * can be frozen part-way through preparing the ringtone, which presents as
     * a call that rings for half a second and stops.
     */
    private fun acquireWakeLock(seconds: Int) {
        releaseWakeLock()
        val pm = getSystemService(PowerManager::class.java) ?: return
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tether:call").apply {
            setReferenceCounted(false)
            acquire((seconds + 30) * 1000L)
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.runCatching { if (isHeld) release() }
        wakeLock = null
    }

    override fun onDestroy() {
        finishQuietly()
        scope.cancel()
        super.onDestroy()
    }

    private fun finishQuietly() {
        ringTimeout?.cancel()
        stopRingtone()
        stopVibration()
        stopSpeech()
        abandonAudioFocus()
        leaveCallAudioMode()
        releaseWakeLock()
        if (CallController.state.value !is CallUiState.Ended) {
            CallController.publish(CallUiState.Idle)
        }
    }

    companion object {
        private const val TAG = "TetherCall"

        /** How long to wait for a Bluetooth headset link before playing regardless. */
        private const val ROUTE_SETTLE_TIMEOUT_MS = 1_500L

        /** Where a call should come out, best first. Matches phone-call behaviour. */
        private val PREFERRED_ROUTES = listOf(
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
        )

        const val ACTION_RING = "tether.call.RING"
        const val ACTION_ANSWER = "tether.call.ANSWER"
        const val ACTION_DECLINE = "tether.call.DECLINE"
        const val ACTION_HANGUP = "tether.call.HANGUP"
        const val ACTION_DISMISS = "tether.call.DISMISS"
        const val ACTION_SPEAKER = "tether.call.SPEAKER"

        /** A further thing the agent said on a call that is already answered. */
        const val ACTION_TURN = "tether.call.TURN"

        const val EXTRA_CALL = "call"
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_REASON = "reason"
        const val EXTRA_SPEAKER_ON = "speakerOn"
        const val EXTRA_AUDIO_URL = "audioUrl"
        const val EXTRA_TEXT = "text"

        /** Ring cadence, repeating from index 0. */
        private val RING_PATTERN = longArrayOf(0, 400, 600, 800, 600)

        /** How long a text-only call stays on screen before it hangs up itself. */
        private const val READ_TIME_MS = 8_000L

        /**
         * How long the line is held after the agent finishes a turn. Matches
         * the server's CALL_LISTEN_TIMEOUT_SEC default: past that point the
         * agent has stopped waiting, so neither should the phone.
         */
        private const val HOLD_OPEN_MS = 120_000L

        /** Wake-lock window covering connecting plus the agent's first turn. */
        private const val CONNECT_WAKE_SECONDS = 60
    }
}

/* ------------------------------------------------------ IncomingCall <-> Bundle -- */

/**
 * Hand-rolled rather than Parcelable.
 *
 * IncomingCall lives in the data layer and is parsed from an FCM map; making it
 * Parcelable would drag an Android dependency into a class that is otherwise
 * pure. Six fields is cheaper than that coupling.
 */
fun IncomingCall.toBundle(): Bundle = Bundle().apply {
    putString("callId", callId)
    putString("requestId", requestId)
    putString("title", title)
    putString("body", body)
    putString("agent", agent)
    putString("actionToken", actionToken)
    putString("audioUrl", audioUrl)
    putStringArray("choices", choices.toTypedArray())
    putInt("ringSeconds", ringSeconds)
}

fun Bundle.toIncomingCall(): IncomingCall? {
    val callId = getString("callId") ?: return null
    return IncomingCall(
        callId = callId,
        requestId = getString("requestId").orEmpty(),
        title = getString("title").orEmpty(),
        body = getString("body").orEmpty(),
        agent = getString("agent").orEmpty(),
        actionToken = getString("actionToken").orEmpty(),
        audioUrl = getString("audioUrl"),
        choices = getStringArray("choices")?.toList().orEmpty(),
        ringSeconds = getInt("ringSeconds", 45),
    )
}
