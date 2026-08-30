package tech.mehdiacho.tether.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import tech.mehdiacho.tether.data.AgentSession
import tech.mehdiacho.tether.data.Delivery
import tech.mehdiacho.tether.data.SessionMessage
import tech.mehdiacho.tether.data.SessionState

/**
 * The home page: what is running, and what it wants.
 *
 * ## The ordering rule, which is the whole design
 *
 * Sessions that are BLOCKED come first, always, regardless of how recently
 * anything happened. That is the question this screen exists to answer — "is
 * anything stuck waiting for me?" — and it is the only one that cannot be
 * answered from a notification shade after the fact. Recency orders the rest.
 *
 * ## Sessions and agents are not the same row
 *
 * Subagents are drawn nested under the session that spawned them, indented and
 * without a chevron, because they cannot be opened for conversation — they have
 * a transcript but no inbox. Listing them as peers would make a session with
 * four subagents look like five things needing attention, and invite taps that
 * cannot do anything.
 */
@Composable
fun SessionsTab(store: TetherStore) {
    val scope = rememberCoroutineScope()
    val open = store.openSession

    if (open != null) {
        SessionDetail(store, open)
        return
    }

    if (store.sessions.isEmpty()) {
        Empty(
            "No sessions registered.\n" +
                "Wire up the Tether hooks and your sessions will appear here.",
        )
        return
    }

    // Blocked first, then most recently active. Sorting here rather than on the
    // server because it is a presentation choice, and the same list is used by
    // things that want it in registry order.
    val ordered = store.sessions.sortedWith(
        compareByDescending<AgentSession> { it.state == SessionState.WAITING }
            .thenByDescending { it.lastSeenAt },
    )

    LazyColumn(
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(ordered, key = { it.id }) { session ->
            SessionCard(session = session, onOpen = { scope.launch { store.open(session) } })
        }
    }
}

@Composable
private fun SessionCard(session: AgentSession, onOpen: () -> Unit) {
    val waiting = session.state == SessionState.WAITING
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen),
        colors = CardDefaults.cardColors(
            // A blocked session is tinted rather than badged: it has to be
            // findable in a list read at arm's length, one-handed.
            containerColor = if (waiting) {
                MaterialTheme.colorScheme.errorContainer
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            },
        ),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StateDot(session.state)
                Spacer(Modifier.width(10.dp))
                Text(
                    session.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (session.pending > 0) {
                    // Queued, not delivered. Worth its own affordance: the relay
                    // may be down, and "sent" would be the wrong word for it.
                    Text(
                        "${session.pending} queued",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            if (session.cwd.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(
                    session.cwd,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            val line = session.waitingOn ?: session.preview
            if (line.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(
                    line,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (!session.transport.addressable && session.state != SessionState.ENDED) {
                Spacer(Modifier.height(8.dp))
                Text(
                    "Visible only — no relay is running for this machine.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (session.agents.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                for (agent in session.agents.sortedByDescending { it.lastSeenAt }) {
                    AgentRow(agent)
                }
            }

            Spacer(Modifier.height(6.dp))
            Text(
                relativeTime(session.lastSeenAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** A subagent: indented, unclickable, and visibly subordinate. */
@Composable
private fun AgentRow(agent: AgentSession) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, top = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StateDot(agent.state, size = 6.dp)
        Spacer(Modifier.width(8.dp))
        Text(
            agent.agentType?.takeIf { it.isNotBlank() } ?: agent.title,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
        )
        if (agent.preview.isNotBlank()) {
            Spacer(Modifier.width(8.dp))
            Text(
                agent.preview,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun StateDot(state: SessionState, size: androidx.compose.ui.unit.Dp = 9.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(stateColour(state)))
}

private fun stateColour(state: SessionState): Color = when (state) {
    SessionState.WAITING -> Color(0xFFE5484D)
    SessionState.WORKING -> Color(0xFF6FD3A6)
    SessionState.IDLE -> Color(0xFF9AA0A6)
    else -> Color(0xFF5F6368)
}

/* ---------------------------------------------------------------- detail -- */

/**
 * One session's timeline, and the composer for talking back to it.
 *
 * The composer is disabled — visibly, with the reason — when nothing can carry
 * the message. That is the honest rendering of the underlying constraint: there
 * is no third-party way into a running Claude Code session, so a session with no
 * relay behind it is readable and not writable, and pretending otherwise would
 * lose whatever was typed.
 */
@Composable
private fun SessionDetail(store: TetherStore, session: AgentSession) {
    val scope = rememberCoroutineScope()
    var draft by remember(session.id) { mutableStateOf("") }
    var sending by remember(session.id) { mutableStateOf(false) }
    val listState = rememberLazyListState()

    // Follow the tail as it grows. Anchoring on size rather than the list keeps
    // this from fighting a scroll back through history on every poll.
    LaunchedEffect(store.openMessages.size) {
        if (store.openMessages.isNotEmpty()) {
            listState.animateScrollToItem(store.openMessages.lastIndex)
        }
    }

    val submit: () -> Unit = {
        val text = draft.trim()
        if (text.isNotEmpty() && !sending) {
            sending = true
            scope.launch {
                // Only clear the box on success. A refused message that also
                // vanished would have to be retyped from memory.
                if (store.send(text)) draft = ""
                sending = false
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = store::closeSession) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
            Column(Modifier.weight(1f)) {
                Text(
                    session.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    session.waitingOn ?: session.cwd,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            StateDot(session.state)
            Spacer(Modifier.width(16.dp))
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(store.openMessages, key = { it.id }) { message -> MessageBubble(message) }
        }

        store.sendError?.let { reason ->
            Text(
                reason,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }

        if (session.canReceive) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(12.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = {
                        draft = it
                        store.clearSendError()
                    },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Message this session") },
                    enabled = !sending,
                    maxLines = 4,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { submit() }),
                )
                IconButton(onClick = submit, enabled = draft.isNotBlank() && !sending) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
                }
            }
        } else {
            Text(
                text = whyNotWritable(session),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(16.dp),
            )
        }
    }
}

private fun whyNotWritable(session: AgentSession): String = when {
    session.isAgent ->
        "Subagents have no inbox. Message the session that spawned this one instead."
    session.state == SessionState.ENDED ->
        "This session has ended. Its transcript stays here."
    else ->
        "Nothing can reach this session — no relay is running on its machine."
}

@Composable
private fun MessageBubble(message: SessionMessage) {
    if (message.isSystem) {
        Text(
            message.text,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        )
        return
    }

    val mine = message.fromHuman
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth(0.86f)
                .clip(RoundedCornerShape(14.dp))
                .background(
                    if (mine) MaterialTheme.colorScheme.primaryContainer
                    else MaterialTheme.colorScheme.surfaceVariant,
                )
                .padding(12.dp),
        ) {
            Text(message.text, style = MaterialTheme.typography.bodyMedium)

            // Delivery is shown only for what this phone sent, and only when it
            // is not the boring case. A message still sitting in the queue looks
            // identical to a delivered one otherwise, which is the difference
            // between "it has my answer" and "it never got it".
            if (mine && message.delivery != Delivery.DELIVERED) {
                Spacer(Modifier.height(4.dp))
                Text(
                    deliveryLabel(message),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (message.delivery == Delivery.QUEUED) {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    } else {
                        MaterialTheme.colorScheme.error
                    },
                )
            }
        }
    }
}

private fun deliveryLabel(message: SessionMessage): String = when (message.delivery) {
    Delivery.QUEUED -> "Waiting for the relay…"
    Delivery.FAILED -> message.error ?: "Could not be delivered."
    Delivery.EXPIRED -> "Expired before anything collected it."
    else -> ""
}
