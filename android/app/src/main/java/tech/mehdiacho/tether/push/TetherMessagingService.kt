package tech.mehdiacho.tether.push

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import tech.mehdiacho.tether.call.CallController
import tech.mehdiacho.tether.data.IncomingCall
import tech.mehdiacho.tether.data.Prefs
import tech.mehdiacho.tether.data.TetherClient
import tech.mehdiacho.tether.ui.MessageNotifier

/**
 * Where every push lands.
 *
 * The server sends data-only messages, so nothing here is drawn by the system:
 * this class decides whether a payload becomes a ringing screen or a message in
 * the shade. That is the whole reason for data-only — a `notification` payload
 * would be rendered by the OS while the app is backgrounded, and an incoming
 * call would arrive as a silent card instead of a ringing phone.
 *
 * Time budget: FCM gives roughly 10 seconds of foreground-service-launch grace
 * for a high-priority message. Ringing must therefore happen synchronously on
 * this thread, before any network call. Everything slower — fetching audio,
 * refreshing lists — happens after the UI is already up.
 */
class TetherMessagingService : FirebaseMessagingService() {

    private val scope = CoroutineScope(Dispatchers.IO)

    /**
     * Called when Firebase issues or rotates this device's token.
     *
     * A rotation the server never hears about is a phone that has silently
     * stopped ringing, which is the single worst failure this app can have — so
     * it is retried on next app start via [Prefs.reportedPushToken] if the
     * server is unreachable right now.
     */
    override fun onNewToken(token: String) {
        val prefs = Prefs(this)
        if (!prefs.isPaired) {
            // Not paired yet. The pairing request itself will carry the token.
            prefs.reportedPushToken = ""
            return
        }
        scope.launch {
            TetherClient(this@TetherMessagingService)
                .registerPushToken(token, force = true)
                .onFailure { Log.w(TAG, "could not register rotated push token: ${it.message}") }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        when (data["type"]) {
            "call.incoming" -> {
                val call = IncomingCall.from(data)
                if (call == null) {
                    Log.w(TAG, "call.incoming without a callId; ignoring")
                    return
                }
                // Synchronous and first. See the note on the time budget above.
                CallController.ring(this, call)
            }

            /*
             * The call is over — answered on another device, declined, or it
             * rang out. Whatever this device is showing for that call is now
             * wrong, so tear it down. Without this, answering on a tablet
             * leaves the phone ringing at nothing.
             */
            // A further turn on a call already in progress. Arrives as a push
            // because the phone may be face-down in a pocket or a car mount
            // between turns, exactly as it was before the first ring.
            "call.turn" -> {
                val callId = data["callId"] ?: return
                CallController.turn(
                    this,
                    callId,
                    data["audioUrl"].orEmpty(),
                    data["text"].orEmpty(),
                )
            }

            "call.ended" -> {
                val callId = data["callId"] ?: return
                CallController.dismiss(this, callId, data["reason"].orEmpty())
            }

            "request.created" -> MessageNotifier.show(this, data)

            else -> Log.d(TAG, "unhandled push type: ${data["type"]}")
        }
    }

    private companion object {
        const val TAG = "TetherFCM"
    }
}
