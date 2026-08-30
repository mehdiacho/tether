package tech.mehdiacho.tether.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * The wire shapes, mirrored from the server's `types.ts`.
 *
 * Parsed with org.json rather than a serialization library: the payloads are
 * small and flat, and every field here is one the server is contractually
 * required to send, so a reflective parser would buy nothing but a compiler
 * plugin. Unknown fields are ignored, which is what lets an older app keep
 * working against a newer server.
 */

enum class RequestKind { NOTIFY, ASK, ACTION, SECRET, CALL, UNKNOWN;

    companion object {
        fun parse(raw: String?): RequestKind = when (raw?.lowercase()) {
            "notify" -> NOTIFY
            "ask" -> ASK
            "action" -> ACTION
            "secret" -> SECRET
            "call" -> CALL
            else -> UNKNOWN
        }
    }
}

enum class RequestStatus { PENDING, ANSWERED, REFUSED, TIMED_OUT, CANCELLED, UNKNOWN;

    companion object {
        fun parse(raw: String?): RequestStatus = when (raw?.lowercase()) {
            "pending" -> PENDING
            "answered" -> ANSWERED
            "refused" -> REFUSED
            "timed_out" -> TIMED_OUT
            "cancelled" -> CANCELLED
            else -> UNKNOWN
        }
    }
}

data class TetherRequest(
    val id: String,
    val kind: RequestKind,
    val title: String,
    val body: String,
    val choices: List<String>,
    val context: Map<String, String>,
    val priority: String,
    val status: RequestStatus,
    val answer: String?,
    val audioId: String?,
    val actionToken: String,
    val agentName: String,
    val createdAt: Long,
    val expiresAt: Long,
) {
    val isPending: Boolean get() = status == RequestStatus.PENDING

    companion object {
        fun from(o: JSONObject): TetherRequest = TetherRequest(
            id = o.optString("id"),
            kind = RequestKind.parse(o.optString("kind")),
            title = o.optString("title"),
            body = o.optString("body"),
            choices = o.optJSONArray("choices").toStringList(),
            context = o.optJSONObject("context").toStringMap(),
            priority = o.optString("priority", "default"),
            status = RequestStatus.parse(o.optString("status")),
            answer = o.optStringOrNull("answer"),
            audioId = o.optStringOrNull("audioId"),
            actionToken = o.optString("actionToken"),
            agentName = o.optString("agentName", "agent"),
            createdAt = o.optLong("createdAt"),
            expiresAt = o.optLong("expiresAt"),
        )
    }
}

enum class CallState { RINGING, ANSWERED, DECLINED, MISSED, ENDED, UNKNOWN;

    companion object {
        fun parse(raw: String?): CallState = when (raw?.lowercase()) {
            "ringing" -> RINGING
            "answered" -> ANSWERED
            "declined" -> DECLINED
            "missed" -> MISSED
            "ended" -> ENDED
            else -> UNKNOWN
        }
    }
}

data class CallSession(
    val id: String,
    val requestId: String,
    val state: CallState,
    val createdAt: Long,
    val answeredAt: Long?,
) {
    companion object {
        fun from(o: JSONObject) = CallSession(
            id = o.optString("id"),
            requestId = o.optString("requestId"),
            state = CallState.parse(o.optString("state")),
            createdAt = o.optLong("createdAt"),
            answeredAt = if (o.isNull("answeredAt")) null else o.optLong("answeredAt"),
        )
    }
}

/** One piece of speech to play during a call. */
data class CallSegment(val url: String, val text: String, val seq: Int) {
    companion object {
        fun from(o: JSONObject) = CallSegment(
            url = o.optString("url"),
            text = o.optString("text"),
            seq = o.optInt("seq"),
        )
    }
}

/**
 * Everything the ringing screen needs, carried in the FCM payload.
 *
 * The push is self-contained on purpose: a phone that has just woken from Doze
 * on a bad connection must be able to draw the ringing screen without a
 * round-trip first. The network is only needed once the call is answered.
 */
data class IncomingCall(
    val callId: String,
    val requestId: String,
    val title: String,
    val body: String,
    val agent: String,
    val actionToken: String,
    val audioUrl: String?,
    val choices: List<String>,
    val ringSeconds: Int,
) {
    companion object {
        fun from(data: Map<String, String>): IncomingCall? {
            val callId = data["callId"] ?: return null
            return IncomingCall(
                callId = callId,
                requestId = data["requestId"].orEmpty(),
                title = data["title"].orEmpty().ifBlank { "Call" },
                body = data["body"].orEmpty(),
                agent = data["agent"].orEmpty().ifBlank { "agent" },
                actionToken = data["actionToken"].orEmpty(),
                audioUrl = data["audioUrl"],
                choices = runCatching {
                    data["choices"]?.let { JSONArray(it).toStringList() }
                }.getOrNull().orEmpty(),
                ringSeconds = data["ringSeconds"]?.toIntOrNull() ?: 45,
            )
        }
    }
}

/* -------------------------------------------------------------- sessions -- */

/**
 * Live phase of a session, as its own hooks reported it.
 *
 * WAITING is the one that matters: it means the session is BLOCKED on a human,
 * which is the only state worth ringing a phone about. IDLE just means it
 * finished its turn.
 */
enum class SessionState { WORKING, IDLE, WAITING, ENDED, UNKNOWN;

    companion object {
        fun parse(raw: String?): SessionState = when (raw?.lowercase()) {
            "working" -> WORKING
            "idle" -> IDLE
            "waiting" -> WAITING
            "ended" -> ENDED
            else -> UNKNOWN
        }
    }
}

/**
 * How a message reaches a session, or that nothing can.
 *
 * NONE is not an error state and is not hidden. There is no third-party API for
 * pushing into a running Claude Code session, so a session with no relay behind
 * it genuinely cannot be written to — and the honest thing is to show it and
 * disable the composer, rather than accept text that goes nowhere.
 */
enum class SessionTransport { RELAY, REMOTE_CONTROL, NONE;

    val addressable: Boolean get() = this != NONE

    companion object {
        fun parse(raw: String?): SessionTransport = when (raw?.lowercase()) {
            "relay" -> RELAY
            "remote-control" -> REMOTE_CONTROL
            else -> NONE
        }
    }
}

/**
 * A session or a subagent.
 *
 * One type for both, because they render the same way and arrive in one tree.
 * [isAgent] is the whole distinction: a session is something Mehdi started and
 * can talk to; an agent is a subagent some session spawned, which has a
 * transcript but no inbox.
 */
data class AgentSession(
    val id: String,
    val externalId: String,
    val parentId: String?,
    val kind: String,
    val agentType: String?,
    val title: String,
    val cwd: String,
    val transport: SessionTransport,
    val state: SessionState,
    val waitingOn: String?,
    val lastSeenAt: Long,
    /** Last thing said, for the list row. Empty on a bare session. */
    val preview: String = "",
    /** Messages queued but not yet delivered by a relay. */
    val pending: Int = 0,
    val agents: List<AgentSession> = emptyList(),
) {
    val isAgent: Boolean get() = kind == "agent"

    /** Can Mehdi type to it right now? */
    val canReceive: Boolean
        get() = !isAgent && transport.addressable && state != SessionState.ENDED

    companion object {
        fun from(o: JSONObject): AgentSession = AgentSession(
            id = o.optString("id"),
            externalId = o.optString("externalId"),
            parentId = o.optStringOrNull("parentId"),
            kind = o.optString("kind", "session"),
            agentType = o.optStringOrNull("agentType"),
            title = o.optString("title").ifBlank { "Session" },
            cwd = o.optString("cwd"),
            transport = SessionTransport.parse(o.optString("transport")),
            state = SessionState.parse(o.optString("state")),
            waitingOn = o.optStringOrNull("waitingOn"),
            lastSeenAt = o.optLong("lastSeenAt"),
            preview = o.optString("preview"),
            pending = o.optInt("pending"),
            agents = (0 until (o.optJSONArray("agents")?.length() ?: 0)).map {
                from(o.getJSONArray("agents").getJSONObject(it))
            },
        )
    }
}

/** Delivery state of something typed on this phone. */
enum class Delivery { NONE, QUEUED, DELIVERED, FAILED, EXPIRED;

    companion object {
        fun parse(raw: String?): Delivery = when (raw?.lowercase()) {
            "queued" -> QUEUED
            "delivered" -> DELIVERED
            "failed" -> FAILED
            "expired" -> EXPIRED
            else -> NONE
        }
    }
}

data class SessionMessage(
    val id: String,
    val seq: Int,
    /** "agent", "human" or "system". */
    val role: String,
    val text: String,
    val delivery: Delivery,
    val error: String?,
    val createdAt: Long,
) {
    val fromHuman: Boolean get() = role == "human"
    val isSystem: Boolean get() = role == "system"

    companion object {
        fun from(o: JSONObject) = SessionMessage(
            id = o.optString("id"),
            seq = o.optInt("seq"),
            role = o.optString("role"),
            text = o.optString("text"),
            delivery = Delivery.parse(o.optString("delivery")),
            error = o.optStringOrNull("error"),
            createdAt = o.optLong("createdAt"),
        )
    }
}

/* ------------------------------------------------------------------ json -- */

fun JSONArray?.toStringList(): List<String> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { optString(it).takeIf(String::isNotEmpty) }
}

fun JSONObject?.toStringMap(): Map<String, String> {
    if (this == null) return emptyMap()
    return keys().asSequence().associateWith { optString(it) }
}

/**
 * org.json turns a JSON null into the *string* "null", which then renders as
 * the word "null" in the UI. Every nullable field goes through this.
 */
fun JSONObject.optStringOrNull(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }
