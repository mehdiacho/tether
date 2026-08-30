package tech.mehdiacho.tether.call

import android.content.Context
import android.content.Intent
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import tech.mehdiacho.tether.data.IncomingCall

/**
 * The one place that knows what call is happening.
 *
 * Both the ringing Activity and the notification are views onto this. They must
 * never hold their own idea of call state: the Activity can be destroyed by a
 * rotation or killed by the system while the service keeps running, and the
 * notification outlives the Activity entirely. Keeping the truth in a service-
 * owned StateFlow means every surface either agrees or is gone.
 *
 * A process-level object is the right scope here because a call is inherently
 * singular — there is exactly one ringing phone.
 */
object CallController {

    private val _state = MutableStateFlow<CallUiState>(CallUiState.Idle)
    val state: StateFlow<CallUiState> = _state.asStateFlow()

    /** Set by [CallService]; nothing else should write call state. */
    internal fun publish(next: CallUiState) {
        _state.value = next
    }

    val activeCallId: String? get() = _state.value.call?.callId

    fun ring(context: Context, call: IncomingCall) {
        val intent = Intent(context, CallService::class.java).apply {
            action = CallService.ACTION_RING
            putExtra(CallService.EXTRA_CALL, call.toBundle())
        }
        startService(context, intent)
    }

    fun answer(context: Context) = send(context, CallService.ACTION_ANSWER)
    fun decline(context: Context) = send(context, CallService.ACTION_DECLINE)
    fun hangUp(context: Context) = send(context, CallService.ACTION_HANGUP)

    /**
     * Routed through the service rather than touching AudioManager from the UI:
     * the service owns the audio mode and focus, and a speaker toggle that
     * outlives the Activity has to be applied by whoever is still playing.
     */
    fun setSpeaker(context: Context, on: Boolean) {
        val intent = Intent(context, CallService::class.java).apply {
            action = CallService.ACTION_SPEAKER
            putExtra(CallService.EXTRA_SPEAKER_ON, on)
        }
        startService(context, intent)
    }

    /**
     * Tear down a call that ended elsewhere.
     *
     * Guarded on the id so a late "ended" push for a previous call cannot kill a
     * new one that started in the meantime — on a flaky connection those arrive
     * out of order more often than you would like.
     */
    /** A further thing the agent said on a call that is already up. */
    fun turn(context: Context, callId: String, audioUrl: String, text: String) {
        if (activeCallId != null && activeCallId != callId) return
        val intent = Intent(context, CallService::class.java).apply {
            action = CallService.ACTION_TURN
            putExtra(CallService.EXTRA_CALL_ID, callId)
            putExtra(CallService.EXTRA_AUDIO_URL, audioUrl)
            putExtra(CallService.EXTRA_TEXT, text)
        }
        startService(context, intent)
    }

    fun dismiss(context: Context, callId: String, reason: String) {
        if (activeCallId != null && activeCallId != callId) return
        val intent = Intent(context, CallService::class.java).apply {
            action = CallService.ACTION_DISMISS
            putExtra(CallService.EXTRA_CALL_ID, callId)
            putExtra(CallService.EXTRA_REASON, reason)
        }
        startService(context, intent)
    }

    private fun send(context: Context, action: String) {
        val intent = Intent(context, CallService::class.java).apply { this.action = action }
        startService(context, intent)
    }

    /**
     * A ring arrives while the app is in the background, so this has to be
     * startForegroundService — a plain startService would be refused. The
     * service then has a few seconds to call startForeground or the system
     * kills it, which is why CallService does that first thing.
     */
    private fun startService(context: Context, intent: Intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
    }
}

/** What the ringing screen and the notification render. */
sealed interface CallUiState {

    val call: IncomingCall? get() = null

    data object Idle : CallUiState

    data class Ringing(override val call: IncomingCall) : CallUiState

    /** Answered locally; waiting on the server to confirm and hand over audio. */
    data class Connecting(override val call: IncomingCall) : CallUiState

    /** Connected and speaking. [spoken] is what is being said, for on-screen text. */
    data class Active(
        override val call: IncomingCall,
        val spoken: String,
        val speaking: Boolean,
    ) : CallUiState

    /**
     * The agent has stopped talking and the line is still open.
     *
     * A call that hangs up the instant the other party stops speaking is not a
     * call, it is a voicemail played at you — so the line is held here, waiting
     * for the agent's next turn. [spoken] is the last thing the agent said,
     * kept on screen so the line does not go visually blank while it is held.
     * [draft] is the caller's own words as the phone hears them, and [thinking]
     * marks the gap between them finishing and the agent answering — the point
     * in a call where silence with no explanation reads as a dropped line.
     */
    data class Listening(
        override val call: IncomingCall,
        val spoken: String,
        val draft: String = "",
        val thinking: Boolean = false,
    ) : CallUiState

    data class Ended(override val call: IncomingCall, val reason: String) : CallUiState
}
