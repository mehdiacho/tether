package tech.mehdiacho.tether.call

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import tech.mehdiacho.tether.R
import tech.mehdiacho.tether.data.IncomingCall

/**
 * The notification side of a call.
 *
 * Two things have to be true for a phone to actually ring:
 *
 *  1. a high-importance notification carrying a **full-screen intent**, and
 *  2. an Activity that may show over the lock screen.
 *
 * The full-screen intent is what asks the system to launch the ringing screen
 * instead of drawing a heads-up card. On a locked or idle device the system
 * honours it; on an actively-used device it deliberately shows the heads-up
 * card instead so it cannot steal focus mid-typing. That is why the service
 * *also* starts the Activity directly — between the two, the call surfaces in
 * every state.
 */
class CallNotifier(private val context: Context) {

    private val manager = NotificationManagerCompat.from(context)

    /**
     * Android 14 restricts USE_FULL_SCREEN_INTENT to apps Play classifies as
     * calling or alarm apps. If it is missing the call still arrives, as a
     * heads-up notification — degraded but not broken. The settings screen is
     * the only way back, so [MainActivity] surfaces this.
     */
    fun canRingFullScreen(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
        val nm = context.getSystemService(NotificationManager::class.java) ?: return false
        return nm.canUseFullScreenIntent()
    }

    private fun hasNotificationPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    /* ------------------------------------------------------------- intents -- */

    private fun ringingScreenIntent(call: IncomingCall) =
        Intent(context, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(CallService.EXTRA_CALL, call.toBundle())
        }

    private fun fullScreenPending(call: IncomingCall): PendingIntent =
        PendingIntent.getActivity(
            context,
            REQ_FULL_SCREEN,
            ringingScreenIntent(call),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun action(name: String, requestCode: Int): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            requestCode,
            Intent(context, CallActionReceiver::class.java).setAction(name),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /* ------------------------------------------------------- notifications -- */

    fun ringing(call: IncomingCall): Notification {
        val answer = action(CallService.ACTION_ANSWER, REQ_ANSWER)
        val decline = action(CallService.ACTION_DECLINE, REQ_DECLINE)

        val builder = Notification.Builder(context, context.getString(R.string.channel_calls))
            .setSmallIcon(R.drawable.ic_call)
            .setContentTitle(call.title)
            .setContentText("${call.agent} is calling")
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            // Keeps the ring on screen rather than letting it auto-collapse
            // after a few seconds like an ordinary heads-up notification.
            .setFullScreenIntent(fullScreenPending(call), true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setAutoCancel(false)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // CallStyle gives the platform's own answer/decline treatment —
            // correctly coloured buttons, correct ordering, and a layout the
            // user already recognises as a call.
            val caller = android.app.Person.Builder()
                .setName(call.agent)
                .setImportant(true)
                .build()
            builder.setStyle(
                Notification.CallStyle.forIncomingCall(caller, decline, answer),
            )
        } else {
            builder
                .addAction(Notification.Action.Builder(R.drawable.ic_call_end, "Decline", decline).build())
                .addAction(Notification.Action.Builder(R.drawable.ic_call, "Answer", answer).build())
        }

        return builder.build()
    }

    fun ongoing(call: IncomingCall, status: String): Notification {
        val hangUp = action(CallService.ACTION_HANGUP, REQ_HANGUP)

        val builder = Notification.Builder(context, context.getString(R.string.channel_ongoing))
            .setSmallIcon(R.drawable.ic_call)
            .setContentTitle(call.title)
            .setContentText(status)
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(fullScreenPending(call))
            .setVisibility(Notification.VISIBILITY_PUBLIC)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val caller = android.app.Person.Builder().setName(call.agent).build()
            builder.setStyle(Notification.CallStyle.forOngoingCall(caller, hangUp))
        } else {
            builder.addAction(
                Notification.Action.Builder(R.drawable.ic_call_end, "Hang up", hangUp).build(),
            )
        }

        return builder.build()
    }

    /**
     * Replace the ongoing notification with a dismissible record of the call.
     *
     * A missed call that leaves nothing behind is indistinguishable from no
     * call at all, which defeats the point of ringing in the first place.
     */
    fun showCallOver(call: IncomingCall, reason: String) {
        if (!hasNotificationPermission()) return

        val notification = Notification.Builder(context, context.getString(R.string.channel_messages))
            .setSmallIcon(R.drawable.ic_call)
            .setContentTitle("$reason · ${call.title}")
            .setContentText(call.body.ifBlank { "from ${call.agent}" })
            .setStyle(Notification.BigTextStyle().bigText(call.body))
            .setCategory(Notification.CATEGORY_CALL)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent())
            .build()

        manager.cancel(CALL_NOTIFICATION_ID)
        manager.notify(call.callId.hashCode(), notification)
    }

    private fun openAppIntent(): PendingIntent {
        val intent = context.packageManager
            .getLaunchIntentForPackage(context.packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ?: Intent()
        return PendingIntent.getActivity(
            context,
            REQ_OPEN,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun update(notification: Notification) {
        if (!hasNotificationPermission()) return
        manager.notify(CALL_NOTIFICATION_ID, notification)
    }

    /**
     * Start the ringing screen directly, in addition to the full-screen intent.
     *
     * Belt and braces on purpose: the system suppresses full-screen intents
     * while the device is in active use, and a call that only appears as a card
     * when you happen to be holding the phone is the exact failure this app
     * exists to avoid.
     */
    fun launchRingingScreen(call: IncomingCall) {
        runCatching { context.startActivity(ringingScreenIntent(call)) }
    }

    companion object {
        const val CALL_NOTIFICATION_ID = 1001

        private const val REQ_FULL_SCREEN = 10
        private const val REQ_ANSWER = 11
        private const val REQ_DECLINE = 12
        private const val REQ_HANGUP = 13
        private const val REQ_OPEN = 14
    }
}
