package tech.mehdiacho.tether.call

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Answer / decline / hang up straight from the notification.
 *
 * This exists so a call can be handled without unlocking the phone or opening
 * the app — which is most of the value of it being a call. It does nothing
 * itself; it forwards to [CallService], which owns the state.
 */
class CallActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            CallService.ACTION_ANSWER -> CallController.answer(context)
            CallService.ACTION_DECLINE -> CallController.decline(context)
            CallService.ACTION_HANGUP -> CallController.hangUp(context)
        }
    }
}
