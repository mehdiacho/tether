package tech.mehdiacho.tether.push

import com.google.firebase.messaging.FirebaseMessaging
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * This device's current FCM token, or null if Firebase cannot issue one.
 *
 * Null is a real outcome, not just an error path: a device without Play
 * Services never gets a token, and the app has to say so plainly at pairing
 * time rather than pairing successfully and then never ringing.
 */
suspend fun currentPushToken(): String? = suspendCancellableCoroutine { cont ->
    FirebaseMessaging.getInstance().token
        .addOnCompleteListener { task ->
            cont.resume(if (task.isSuccessful) task.result else null)
        }
}
