package tech.mehdiacho.tether.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import tech.mehdiacho.tether.call.CallNotifier
import tech.mehdiacho.tether.data.PairingLink
import tech.mehdiacho.tether.data.parsePairingPayload
import tech.mehdiacho.tether.ui.theme.TetherTheme

/**
 * The app's only ordinary Activity — the messages and calls surface.
 *
 * The ringing screen is deliberately not part of this: it is its own task with
 * its own affinity so that answering a call from the lock screen never drops
 * the user into the app's back stack.
 */
class MainActivity : ComponentActivity() {

    /**
     * A `tether://pair` link the app was opened with.
     *
     * Held as state rather than read once, because this Activity is
     * singleTask: a second link arrives through onNewIntent into the instance
     * that is already running, not through a fresh onCreate.
     */
    private var pendingLink by mutableStateOf<PairingLink?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingLink = linkFrom(intent)

        setContent {
            TetherTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    TetherRoot(
                        pairingLink = pendingLink,
                        onPairingLinkHandled = { pendingLink = null },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingLink = linkFrom(intent)
    }

    private fun linkFrom(intent: Intent?): PairingLink? =
        intent?.data?.toString()?.let(::parsePairingPayload)

    companion object {
        const val EXTRA_REQUEST_ID = "requestId"
    }
}

@Composable
private fun TetherRoot(
    pairingLink: PairingLink? = null,
    onPairingLinkHandled: () -> Unit = {},
) {
    val context = LocalContext.current
    val store = remember { TetherStore(context) }

    RequestCallPermissions()

    // Refresh whenever the app comes back to the foreground rather than once on
    // launch: this screen is most often opened from a notification, and the
    // interesting change happened while it was in the background.
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(store.paired) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            store.syncPushToken()
            store.refresh()
        }
    }

    if (store.paired) {
        HomeScreen(
            store = store,
            fullScreenAllowed = remember { CallNotifier(context).canRingFullScreen() },
            onFixFullScreen = { openFullScreenIntentSettings(context) },
        )
    } else {
        PairScreen(
            store = store,
            initialLink = pairingLink,
            onLinkHandled = onPairingLinkHandled,
        )
    }
}

/**
 * The two permissions a call needs, asked for together, once.
 *
 * Both are survivable when refused, in different ways: without notifications a
 * call rings silently, and without the microphone it is one-way. Neither is
 * worth blocking the app over, and asking here rather than mid-call means the
 * system dialog never lands on top of a ringing screen.
 */
@Composable
private fun RequestCallPermissions() {
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { /* Refusal degrades the call; it does not break the app. */ }

    LaunchedEffect(Unit) {
        val wanted = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
            add(Manifest.permission.RECORD_AUDIO)
        }
        launcher.launch(wanted.toTypedArray())
    }
}

/**
 * Android 14 grants USE_FULL_SCREEN_INTENT automatically only to apps Play
 * classifies as calling or alarm apps. Until this app is published in that
 * category, the permission has to be granted by hand — and without it a call
 * arrives as a heads-up card instead of a ringing screen, which is exactly the
 * failure the app exists to avoid. So it is surfaced rather than hidden.
 */
private fun openFullScreenIntentSettings(context: android.content.Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return
    val intent = Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
        .setData(Uri.parse("package:${context.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
}
