package tech.mehdiacho.tether.ui

import android.content.Context
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import tech.mehdiacho.tether.data.AgentSession
import tech.mehdiacho.tether.data.CallSession
import tech.mehdiacho.tether.data.Prefs
import tech.mehdiacho.tether.data.TetherClient
import tech.mehdiacho.tether.data.SessionMessage
import tech.mehdiacho.tether.data.TetherRequest
import tech.mehdiacho.tether.push.currentPushToken

/**
 * What the screens read from and act on.
 *
 * Compose state rather than a ViewModel: the whole app is two lists and a
 * pairing form, and the network is authoritative — a rotation refetching is
 * cheaper than the dependency and the lifecycle plumbing a ViewModel brings.
 *
 * Every method here is a suspend function and every network call is moved to
 * IO explicitly, because [TetherClient] is blocking by design.
 */
class TetherStore(context: Context) {

    private val appContext = context.applicationContext
    private val client = TetherClient(appContext)
    private val prefs = Prefs(appContext)

    var paired by mutableStateOf(prefs.isPaired)
        private set
    var serverUrl by mutableStateOf(prefs.serverUrl)
        private set

    var requests by mutableStateOf<List<TetherRequest>>(emptyList())
        private set
    var calls by mutableStateOf<List<CallSession>>(emptyList())
        private set

    /** Live sessions, each with its subagents nested. The home page. */
    var sessions by mutableStateOf<List<AgentSession>>(emptyList())
        private set

    /** The session being read, if any. Null means the list is showing. */
    var openSession by mutableStateOf<AgentSession?>(null)
        private set
    var openMessages by mutableStateOf<List<SessionMessage>>(emptyList())
        private set

    /**
     * Why the last send was refused.
     *
     * Kept apart from [error] because it belongs under the composer of one
     * session rather than in the banner over every screen — and because the
     * server's wording for a refusal ("nothing can reach that session") is the
     * actual explanation, not a generic failure.
     */
    var sendError by mutableStateOf<String?>(null)
        private set

    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    /** True once the FCM token is registered — the phone will actually ring. */
    var pushReady by mutableStateOf(prefs.reportedPushToken.isNotBlank())
        private set

    /* ------------------------------------------------------------ pairing -- */

    suspend fun pair(url: String, code: String): Boolean {
        loading = true
        error = null
        val token = currentPushToken()
        val result = withContext(Dispatchers.IO) {
            client.pair(url, code, deviceName(), token)
        }
        loading = false

        return result.fold(
            onSuccess = {
                paired = true
                serverUrl = prefs.serverUrl
                pushReady = token != null
                if (token == null) {
                    error = "Paired, but this device has no push token — " +
                        "calls will not ring until Play Services provides one."
                }
                true
            },
            onFailure = {
                error = friendly(it)
                false
            },
        )
    }

    fun unpair() {
        client.unpair()
        paired = false
        serverUrl = ""
        requests = emptyList()
        calls = emptyList()
        sessions = emptyList()
        openSession = null
        openMessages = emptyList()
        pushReady = false
    }

    /**
     * Re-report the push token on every start.
     *
     * Cheap when unchanged — the client skips the POST — and it repairs the one
     * failure that is otherwise invisible: a token that rotated while the
     * server was unreachable, leaving a phone that looks paired and never rings.
     */
    suspend fun syncPushToken() {
        if (!paired) return
        val token = currentPushToken() ?: return
        val ok = withContext(Dispatchers.IO) { client.registerPushToken(token) }.isSuccess
        if (ok) pushReady = true
    }

    /* ------------------------------------------------------------- lists -- */

    suspend fun refresh() {
        if (!paired) return
        loading = true
        val fetched = withContext(Dispatchers.IO) {
            client.listRequests(includeResolved = true) to client.listCalls()
        }
        loading = false

        fetched.first
            .onSuccess { requests = it; error = null }
            .onFailure { error = friendly(it) }
        fetched.second.onSuccess { calls = it }

        // Sessions are fetched separately, and a failure here is swallowed: an
        // older server has no /api/sessions at all, and a 404 for a feature it
        // does not have must not blank out the messages that did arrive.
        withContext(Dispatchers.IO) { client.listSessions() }.onSuccess { sessions = it }

        // Keep an open session's header in step with the list it came from,
        // so a session that ends while being read stops offering a composer.
        openSession?.let { open ->
            val fresh = sessions.firstOrNull { it.id == open.id }
            if (fresh != null) openSession = fresh
            reloadOpenMessages()
        }
    }

    /* ---------------------------------------------------------- sessions -- */

    suspend fun open(session: AgentSession) {
        openSession = session
        openMessages = emptyList()
        sendError = null
        reloadOpenMessages()
    }

    fun closeSession() {
        openSession = null
        openMessages = emptyList()
        sendError = null
    }

    private suspend fun reloadOpenMessages() {
        val id = openSession?.id ?: return
        withContext(Dispatchers.IO) { client.sessionMessages(id) }
            .onSuccess { openMessages = it }
            .onFailure { error = friendly(it) }
    }

    /**
     * Queue a message for the open session.
     *
     * Returns false when the server refused it, with [sendError] set to the
     * server's own wording. Nothing is added to the list optimistically: a
     * message that has not been accepted has not been queued, and showing it as
     * sent is exactly the lie this whole path is built to avoid.
     */
    suspend fun send(text: String): Boolean {
        val id = openSession?.id ?: return false
        sendError = null
        val result = withContext(Dispatchers.IO) { client.sendToSession(id, text) }
        return result.fold(
            onSuccess = {
                reloadOpenMessages()
                refreshSessions()
                true
            },
            onFailure = {
                sendError = refusal(it) ?: friendly(it)
                false
            },
        )
    }

    suspend fun refreshSessions() {
        if (!paired) return
        withContext(Dispatchers.IO) { client.listSessions() }.onSuccess { sessions = it }
    }

    fun clearSendError() {
        sendError = null
    }

    /**
     * The server's explanation for a refusal, when it gave one.
     *
     * A 409 from the send endpoint is not a fault — it is the server saying the
     * target cannot be written to, in wording written to be read by a person.
     * Replacing it with "Server error 409" would throw away the only useful
     * part.
     */
    private fun refusal(t: Throwable): String? {
        val http = t as? TetherClient.HttpError ?: return null
        if (http.code != 409) return null
        return runCatching { JSONObject(http.body).optString("error") }
            .getOrNull()
            ?.takeIf { it.isNotBlank() }
    }

    suspend fun answer(requestId: String, choice: String) {
        // Optimistic: the button should feel instant, and a failed answer is
        // corrected by the refresh that follows.
        val result = withContext(Dispatchers.IO) { client.answer(requestId, choice) }
        result.onFailure { error = friendly(it) }
        refresh()
    }

    suspend fun refuse(requestId: String) {
        withContext(Dispatchers.IO) { client.refuse(requestId) }
            .onFailure { error = friendly(it) }
        refresh()
    }

    fun clearError() {
        error = null
    }

    private fun deviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    private fun friendly(t: Throwable): String = when (t) {
        is TetherClient.HttpError -> when (t.code) {
            401, 403 -> "This device is no longer authorised. Pair it again."
            404 -> "Not found on the server."
            else -> "Server error ${t.code}"
        }

        else -> t.message ?: "Could not reach the server"
    }
}
