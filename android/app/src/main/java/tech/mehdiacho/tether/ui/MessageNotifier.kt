package tech.mehdiacho.tether.ui

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import tech.mehdiacho.tether.R
import tech.mehdiacho.tether.data.toStringList

/**
 * The messaging half of the app.
 *
 * A question from an agent is only useful if it can be answered where it lands.
 * When the request carries choices, each one becomes a notification action that
 * answers the server directly — so "should I deploy?" can be resolved from the
 * lock screen without opening anything.
 */
object MessageNotifier {

    /** Android shows at most three actions; past that they are silently dropped. */
    private const val MAX_ACTIONS = 3

    fun show(context: Context, data: Map<String, String>) {
        if (!canPost(context)) return

        val requestId = data["requestId"] ?: return
        val title = data["title"].orEmpty().ifBlank { "Message" }
        val body = data["body"].orEmpty()
        val agent = data["agent"].orEmpty().ifBlank { "agent" }
        val choices = runCatching {
            data["choices"]?.let { JSONArray(it).toStringList() }
        }.getOrNull().orEmpty()

        val builder = Notification.Builder(context, context.getString(R.string.channel_messages))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body.ifBlank { "from $agent" })
            .setStyle(Notification.BigTextStyle().bigText(body).setSummaryText(agent))
            .setSubText(agent)
            .setAutoCancel(true)
            .setContentIntent(openApp(context, requestId))
            .apply {
                if (data["priority"] == "high") {
                    setCategory(Notification.CATEGORY_REMINDER)
                }
            }

        choices.take(MAX_ACTIONS).forEachIndexed { index, choice ->
            builder.addAction(
                Notification.Action.Builder(
                    R.drawable.ic_notification,
                    choice,
                    // The request id is part of the request code so two pending
                    // questions do not overwrite each other's actions — without
                    // it, FLAG_UPDATE_CURRENT would silently rewire the first
                    // notification's buttons to answer the second one.
                    answerIntent(context, requestId, choice, index),
                ).build(),
            )
        }

        NotificationManagerCompat.from(context).notify(requestId.hashCode(), builder.build())
    }

    /** Called after an action is taken, so the question stops asking. */
    fun dismiss(context: Context, requestId: String) {
        NotificationManagerCompat.from(context).cancel(requestId.hashCode())
    }

    private fun canPost(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    private fun answerIntent(
        context: Context,
        requestId: String,
        choice: String,
        index: Int,
    ): PendingIntent {
        val intent = Intent(context, MessageActionReceiver::class.java)
            .setAction(MessageActionReceiver.ACTION_ANSWER)
            .putExtra(MessageActionReceiver.EXTRA_REQUEST_ID, requestId)
            .putExtra(MessageActionReceiver.EXTRA_ANSWER, choice)

        return PendingIntent.getBroadcast(
            context,
            requestId.hashCode() * 31 + index,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun openApp(context: Context, requestId: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(MainActivity.EXTRA_REQUEST_ID, requestId)

        return PendingIntent.getActivity(
            context,
            requestId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
