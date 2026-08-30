package tech.mehdiacho.tether.ui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tech.mehdiacho.tether.data.TetherClient

/**
 * Answers a question straight from the notification.
 *
 * A broadcast receiver gets ~10 seconds before the system may kill the process,
 * and a POST over mobile data can outlast that — hence goAsync(), which holds
 * the process alive until the request finishes. Without it the answer would be
 * sent optimistically and lost often enough to be untrustworthy, which is worse
 * than not offering the button at all.
 */
class MessageActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_ANSWER) return
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
        val answer = intent.getStringExtra(EXTRA_ANSWER) ?: return

        // Take the question down immediately: the tap already happened, and a
        // notification that lingers reads as a button that did not work.
        MessageNotifier.dismiss(context, requestId)

        val pending = goAsync()
        val app = context.applicationContext
        CoroutineScope(Dispatchers.IO).launch {
            TetherClient(app).answer(requestId, answer)
                .onFailure {
                    Log.w(TAG, "could not answer $requestId: ${it.message}")
                    withContext(Dispatchers.Main) {
                        Toast.makeText(app, "Could not send answer", Toast.LENGTH_SHORT).show()
                    }
                }
            pending.finish()
        }
    }

    companion object {
        private const val TAG = "TetherMsgAction"

        const val ACTION_ANSWER = "tether.message.ANSWER"
        const val EXTRA_REQUEST_ID = "requestId"
        const val EXTRA_ANSWER = "answer"
    }
}
