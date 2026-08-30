package tech.mehdiacho.tether.ui

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import tech.mehdiacho.tether.data.CallSession
import tech.mehdiacho.tether.data.CallState
import androidx.compose.material.icons.filled.Terminal
import tech.mehdiacho.tether.data.RequestKind
import tech.mehdiacho.tether.data.SessionState
import tech.mehdiacho.tether.data.RequestStatus
import tech.mehdiacho.tether.data.TetherRequest

/**
 * Sessions leads because it answers the question the others cannot: is anything
 * stuck waiting for me right now? Messages and Calls are both records of things
 * that already happened.
 */
private enum class Tab(val label: String) {
    SESSIONS("Sessions"),
    MESSAGES("Messages"),
    CALLS("Calls"),
    SETTINGS("Settings"),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    store: TetherStore,
    fullScreenAllowed: Boolean,
    onFixFullScreen: () -> Unit,
) {
    var tab by remember { mutableStateOf(Tab.SESSIONS) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(tab.label) },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = tab == Tab.SESSIONS,
                    onClick = { tab = Tab.SESSIONS },
                    icon = {
                        // A count of what is blocked, not of what exists. A
                        // badge that shows "9" whenever nine sessions are open
                        // trains you to ignore it.
                        val blocked = store.sessions.count { it.state == SessionState.WAITING }
                        if (blocked > 0) {
                            BadgedBox(badge = { Badge { Text("$blocked") } }) {
                                Icon(Icons.Filled.Terminal, null)
                            }
                        } else {
                            Icon(Icons.Filled.Terminal, null)
                        }
                    },
                    label = { Text("Sessions") },
                )
                NavigationBarItem(
                    selected = tab == Tab.MESSAGES,
                    onClick = { tab = Tab.MESSAGES; store.closeSession() },
                    icon = { Icon(Icons.AutoMirrored.Filled.Chat, null) },
                    label = { Text("Messages") },
                )
                NavigationBarItem(
                    selected = tab == Tab.CALLS,
                    onClick = { tab = Tab.CALLS; store.closeSession() },
                    icon = { Icon(Icons.Filled.Call, null) },
                    label = { Text("Calls") },
                )
                NavigationBarItem(
                    selected = tab == Tab.SETTINGS,
                    onClick = { tab = Tab.SETTINGS; store.closeSession() },
                    icon = { Icon(Icons.Filled.Settings, null) },
                    label = { Text("Settings") },
                )
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (store.loading) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }

            // A ringing-disabled app looks identical to a working one until the
            // call you needed never arrives, so this banner sits above content
            // on every tab rather than being buried in Settings.
            if (!fullScreenAllowed) {
                Banner(
                    text = "Calls cannot take over the screen. Without this they " +
                        "arrive as a silent card.",
                    actionLabel = "Allow",
                    onAction = onFixFullScreen,
                )
            }
            if (!store.pushReady) {
                Banner(
                    text = "This device has not registered for push yet — it will not ring.",
                    actionLabel = null,
                    onAction = {},
                )
            }
            store.error?.let {
                Banner(text = it, actionLabel = "Dismiss", onAction = store::clearError)
            }

            when (tab) {
                Tab.SESSIONS -> SessionsTab(store)
                Tab.MESSAGES -> MessagesTab(store)
                Tab.CALLS -> CallsTab(store)
                Tab.SETTINGS -> SettingsTab(store)
            }
        }
    }
}

/* ------------------------------------------------------------- messages -- */

@Composable
private fun MessagesTab(store: TetherStore) {
    val scope = rememberCoroutineScope()

    // A call is not a message. Every call creates a request underneath, which is
    // where its text and recording live, but rendering that row here made the
    // call appear twice and turned Messages into a transcript dump. Calls own
    // their own tab; this one is for things written to be read.
    val messages = store.requests.filter { it.kind != RequestKind.CALL }

    if (messages.isEmpty()) {
        Empty("No messages yet.\nYour agents will reach you here.")
        return
    }

    LazyColumn(
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(messages, key = { it.id }) { request ->
            RequestCard(
                request = request,
                onAnswer = { choice -> scope.launch { store.answer(request.id, choice) } },
                onRefuse = { scope.launch { store.refuse(request.id) } },
            )
        }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun RequestCard(
    request: TetherRequest,
    onAnswer: (String) -> Unit,
    onRefuse: () -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    request.agentName,
                    color = MaterialTheme.colorScheme.primary,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    relativeTime(request.createdAt),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 12.sp,
                )
            }

            Spacer(Modifier.height(6.dp))
            Text(
                request.title,
                color = MaterialTheme.colorScheme.onSurface,
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
            )

            if (request.body.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    request.body,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 15.sp,
                )
            }

            if (request.isPending && request.kind == RequestKind.ASK) {
                Spacer(Modifier.height(12.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    request.choices.forEach { choice ->
                        Button(
                            onClick = { onAnswer(choice) },
                            contentPadding = androidx.compose.foundation.layout
                                .PaddingValues(horizontal = 16.dp, vertical = 6.dp),
                        ) { Text(choice) }
                    }
                    OutlinedButton(
                        onClick = onRefuse,
                        contentPadding = androidx.compose.foundation.layout
                            .PaddingValues(horizontal = 16.dp, vertical = 6.dp),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.error,
                        ),
                    ) { Text("Refuse") }
                }
            } else if (!request.isPending) {
                Spacer(Modifier.height(10.dp))
                Text(
                    statusLabel(request),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 13.sp,
                )
            }
        }
    }
}

private fun statusLabel(request: TetherRequest): String = when (request.status) {
    RequestStatus.ANSWERED -> "Answered: ${request.answer.orEmpty()}"
    RequestStatus.REFUSED -> "Refused"
    RequestStatus.TIMED_OUT -> "Timed out"
    RequestStatus.CANCELLED -> "Cancelled"
    else -> "Delivered"
}

/* ---------------------------------------------------------------- calls -- */

@Composable
private fun CallsTab(store: TetherStore) {
    if (store.calls.isEmpty()) {
        Empty("No calls yet.")
        return
    }

    val player = rememberRecordingPlayer()

    LazyColumn(
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(store.calls, key = { it.id }) { call ->
            CallRow(
                call = call,
                request = store.requests.firstOrNull { it.id == call.requestId },
                serverUrl = store.serverUrl,
                player = player,
            )
        }
    }
}

/**
 * Where a call's recording lives.
 *
 * The token is in the path rather than a header so the URL is self-contained —
 * the same property that lets the ringing phone fetch it before it has done
 * anything else.
 */
private fun recordingUrl(serverUrl: String, request: TetherRequest?): String? {
    if (request?.audioId.isNullOrBlank()) return null
    val base = serverUrl.trimEnd('/')
    if (base.isEmpty()) return null
    return "$base/v/${request!!.id}/${request.actionToken}"
}

@Composable
private fun CallRow(
    call: CallSession,
    request: TetherRequest?,
    serverUrl: String,
    player: RecordingPlayer,
) {
    val url = recordingUrl(serverUrl, request)
    val isPlaying = player.playingId == call.id
    val isLoading = player.loadingId == call.id

    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(38.dp)
                .background(dotColour(call.state).copy(alpha = 0.15f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Filled.Call,
                contentDescription = null,
                tint = dotColour(call.state),
                modifier = Modifier.size(18.dp),
            )
        }

        Spacer(Modifier.size(12.dp))

        Column(Modifier.weight(1f)) {
            Text(
                request?.title ?: "Call",
                color = MaterialTheme.colorScheme.onSurface,
                fontSize = 16.sp,
            )
            Text(
                "${stateLabel(call.state)} · ${relativeTime(call.createdAt)}",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 13.sp,
            )
            // What was said. This is the only place it appears now that calls
            // are out of Messages, so it belongs on the row rather than behind
            // a tap — a missed call you can read is often answer enough.
            request?.body?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.size(4.dp))
                Text(
                    it,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 14.sp,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        if (url != null) {
            Spacer(Modifier.size(8.dp))
            IconButton(onClick = { player.toggle(call.id, url) }) {
                if (isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Icon(
                        if (isPlaying) Icons.Filled.Stop else Icons.Filled.PlayArrow,
                        contentDescription = if (isPlaying) "Stop" else "Play recording",
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }
    }
}

private fun stateLabel(state: CallState): String = when (state) {
    CallState.RINGING -> "Ringing"
    CallState.ANSWERED -> "Answered"
    CallState.DECLINED -> "Declined"
    CallState.MISSED -> "Missed"
    CallState.ENDED -> "Ended"
    CallState.UNKNOWN -> "Unknown"
}

private fun dotColour(state: CallState): Color = when (state) {
    CallState.MISSED, CallState.DECLINED -> Color(0xFFE5484D)
    CallState.RINGING -> Color(0xFFF5A524)
    else -> Color(0xFF30A46C)
}

/* ------------------------------------------------------------- settings -- */

@Composable
private fun SettingsTab(store: TetherStore) {
    Column(Modifier.padding(20.dp)) {
        Text("Server", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            store.serverUrl.ifBlank { "not set" },
            fontSize = 16.sp,
            color = MaterialTheme.colorScheme.onSurface,
        )

        Spacer(Modifier.height(20.dp))

        Text("Push", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            if (store.pushReady) "Registered — this device will ring" else "Not registered",
            fontSize = 16.sp,
            color = MaterialTheme.colorScheme.onSurface,
        )

        Spacer(Modifier.height(28.dp))

        TextButton(
            onClick = store::unpair,
            colors = ButtonDefaults.textButtonColors(
                contentColor = MaterialTheme.colorScheme.error,
            ),
        ) { Text("Unpair this device") }

        Text(
            "Unpairing only clears this phone. Revoke the device on the server " +
                "to stop it being trusted.",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/* --------------------------------------------------------------- pieces -- */

@Composable
private fun Banner(text: String, actionLabel: String?, onAction: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 13.sp,
            modifier = Modifier.weight(1f),
        )
        if (actionLabel != null) {
            TextButton(onClick = onAction) { Text(actionLabel) }
        }
    }
}

@Composable
internal fun Empty(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 15.sp,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

internal fun relativeTime(epochMillis: Long): String {
    if (epochMillis <= 0L) return ""
    return DateUtils.getRelativeTimeSpanString(
        epochMillis,
        System.currentTimeMillis(),
        DateUtils.MINUTE_IN_MILLIS,
    ).toString()
}
