package tech.mehdiacho.tether

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build

/**
 * Application entry point. Its whole job is to declare notification channels
 * before anything tries to post to one.
 *
 * Channels are created once and then become immutable — the user owns them
 * afterwards, and the app cannot turn a sound back on that they turned off.
 * That is the correct behaviour, but it does mean the initial settings matter:
 * a channel created with the wrong importance stays wrong until reinstall.
 */
class TetherApp : Application() {

    override fun onCreate() {
        super.onCreate()
        createChannels()
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return

        /*
         * Calls.
         *
         * IMPORTANCE_HIGH plus a full-screen intent is what produces a ringing
         * screen rather than a heads-up card. The sound is the system ringtone
         * with RINGTONE usage attributes so it routes and ducks like a call —
         * NOTIFICATION usage would play it through the wrong stream and respect
         * the wrong volume slider.
         */
        val calls = NotificationChannel(
            getString(R.string.channel_calls),
            "Calls",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Incoming calls from your agents"
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            enableVibration(true)
            vibrationPattern = RING_PATTERN
            // Only honoured if the user grants Do Not Disturb access. Asking for
            // it is a decision for the user, so this is set optimistically and
            // simply has no effect until they do.
            setBypassDnd(true)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        }

        val messages = NotificationChannel(
            getString(R.string.channel_messages),
            "Messages",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Questions and notifications from your agents"
            enableVibration(true)
        }

        /*
         * The ongoing-call notification. IMPORTANCE_LOW on purpose: this one is
         * a status indicator for a call already in progress, and it must not
         * make a second sound on top of the ringtone.
         */
        val ongoing = NotificationChannel(
            getString(R.string.channel_ongoing),
            "Ongoing call",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shown while a call is connected"
            setShowBadge(false)
        }

        manager.createNotificationChannels(listOf(calls, messages, ongoing))
    }

    private companion object {
        /** Ring cadence: a short buzz, a gap, a longer one. Repeats while ringing. */
        val RING_PATTERN = longArrayOf(0, 400, 600, 800, 600)
    }
}
