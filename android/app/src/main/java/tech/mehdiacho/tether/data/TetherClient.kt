package tech.mehdiacho.tether.data

import android.content.Context
import android.util.Base64
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The server API.
 *
 * Blocking, by design. Every caller is already off the main thread — a
 * coroutine on Dispatchers.IO, or a Service worker — and a blocking client is
 * far easier to reason about than a callback tower when what you need is
 * "answer this call, then play the audio, then hang up".
 *
 * Failures surface as [Result] rather than exceptions crossing layers, because
 * on this app almost every network failure has a sensible local fallback: a
 * call still rings from the push payload alone, and a message list just shows
 * what it had.
 */
class TetherClient(context: Context) {

    private val prefs = Prefs(context)

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        // The call socket must survive a screen-off phone on mobile data, and
        // an unnoticed half-open connection is worse than a reconnect.
        .pingInterval(25, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /**
     * A shorter connect timeout for every address after the first.
     *
     * Ten seconds spent on a dead address is an eternity when the phone is
     * ringing. Anything actually reachable completes a TCP handshake in well
     * under three seconds on both a LAN and a tunnel, so an attempt still
     * connecting after that is almost certainly on the wrong network.
     */
    private val failoverHttp = http.newBuilder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .build()

    val baseUrl: String get() = prefs.serverUrl
    val isPaired: Boolean get() = prefs.isPaired

    private fun url(path: String) = "${prefs.serverUrl}$path"

    private fun authed(path: String): Request.Builder =
        Request.Builder()
            .url(url(path))
            .header("Authorization", "Bearer ${prefs.clientToken}")

    private fun json(body: JSONObject) =
        body.toString().toRequestBody(JSON_MEDIA)

    /**
     * Run a request against exactly one address, with no failover.
     *
     * Pairing uses this: there is one address, the user just typed it, and
     * quietly succeeding against a different server would be a confusing
     * outcome to debug.
     */
    private fun <T> executeOnce(
        request: Request,
        client: OkHttpClient = http,
        parse: (Response) -> T,
    ): Result<T> =
        runCatching {
            client.newCall(request).execute().use { res ->
                if (!res.isSuccessful) {
                    throw HttpError(res.code, res.body?.string().orEmpty())
                }
                parse(res)
            }
        }

    /**
     * Run a request, trying each known address until one answers.
     *
     * The distinction that makes this safe is between *not reaching* a server
     * and *being told no by one*. An IOException means this address is wrong for
     * the current network — the phone left the house, the tunnel is up instead
     * of the LAN — so the next address is worth trying. An [HttpError] means a
     * server answered, and it is this server: retrying a 409 "someone else
     * already answered that call" against a second address would answer the
     * call twice.
     *
     * A working address is promoted to the head of the list, so the cost of
     * being on the wrong network is paid once per network change rather than
     * once per request.
     */
    private fun <T> execute(request: Request, parse: (Response) -> T): Result<T> {
        val bases = prefs.addresses
        if (bases.size <= 1) return executeOnce(request, parse = parse)

        var last: Throwable? = null
        for ((index, base) in bases.withIndex()) {
            val client = if (index == 0) http else failoverHttp
            val result = executeOnce(rebase(request, base), client, parse)
            if (result.isSuccess) {
                if (index != 0) prefs.promote(base)
                return result
            }
            val failure = result.exceptionOrNull()
            if (failure is HttpError) return result
            last = failure
        }
        return Result.failure(last ?: IOException("no server address is configured"))
    }

    /**
     * Point a request at a different address, keeping its path, query and body.
     *
     * Rebuilt from the parsed URL rather than spliced from strings, so an
     * already-encoded path survives untouched — call and audio IDs are opaque
     * and a second encoding pass would quietly corrupt them.
     */
    private fun rebase(request: Request, base: String): Request {
        val old = request.url
        val target = (base + old.encodedPath).toHttpUrlOrNull() ?: return request
        val rebuilt = target.newBuilder().encodedQuery(old.encodedQuery).build()
        return request.newBuilder().url(rebuilt).build()
    }

    private fun bodyJson(res: Response): JSONObject =
        JSONObject(res.body?.string().orEmpty().ifBlank { "{}" })

    /* ------------------------------------------------------------ pairing -- */

    /**
     * Trade a pairing code for a device token.
     *
     * The only unauthenticated call in the app, and the only one that takes an
     * explicit server URL — at this point nothing is stored yet.
     */
    fun pair(serverUrl: String, code: String, deviceName: String, pushToken: String?): Result<Unit> {
        val clean = serverUrl.trim().trimEnd('/')
        val payload = JSONObject()
            .put("code", code.trim().uppercase())
            .put("name", deviceName)
            .put("platform", "android")
            .apply { pushToken?.let { put("pushToken", it) } }

        val request = Request.Builder()
            .url("$clean/api/pair/claim")
            .post(json(payload))
            .build()

        // executeOnce, not execute: pairing must hit the address the user gave.
        return executeOnce(request, parse = ::bodyJson).map { o ->
            prefs.addresses = listOf(clean)
            prefs.clientToken = o.optString("clientToken")
            prefs.deviceId = o.optString("deviceId")
            prefs.reportedPushToken = pushToken.orEmpty()
        }
    }

    fun unpair() = prefs.clear()

    /**
     * Ask the server what it calls itself, and every address it believes it can
     * be reached at.
     *
     * The interesting one is the address this very request arrived on, which the
     * server reads off the Host header. That is how a device paired on the LAN
     * learns its tunnel address without anyone typing it: pair at home, open the
     * app once over the tunnel, and the second route is now known.
     */
    fun serverInfo(): Result<ServerInfo> {
        val request = authed("/api/server").get().build()
        return execute(request, ::bodyJson).map(ServerInfo::from)
    }

    /**
     * Check one specific address, ignoring the list.
     *
     * Backs the "test" button in settings, where the whole question is whether
     * *this* address works — failing over to a working one would answer a
     * different question and look like a pass.
     */
    fun testAddress(address: String): Result<ServerInfo> {
        val clean = address.trim().trimEnd('/')
        val request = Request.Builder()
            .url("$clean/api/server")
            .header("Authorization", "Bearer ${prefs.clientToken}")
            .get()
            .build()
        return executeOnce(request, failoverHttp, ::bodyJson).map(ServerInfo::from)
    }

    /**
     * Tell the server this device's current FCM token.
     *
     * Skipped when unchanged — this runs on every app start, and the useful
     * case is the rare rotation, not the common no-op.
     */
    fun registerPushToken(token: String, force: Boolean = false): Result<Unit> {
        if (!prefs.isPaired) return Result.failure(IllegalStateException("not paired"))
        if (!force && token == prefs.reportedPushToken) return Result.success(Unit)

        val request = authed("/api/devices/push-token")
            .post(json(JSONObject().put("pushToken", token)))
            .build()

        return execute(request) { }.map { prefs.reportedPushToken = token }
    }

    /* ----------------------------------------------------------- requests -- */

    fun listRequests(includeResolved: Boolean): Result<List<TetherRequest>> {
        val request = authed("/api/requests${if (includeResolved) "?all=1" else ""}").get().build()
        return execute(request, ::bodyJson).map { o ->
            o.optJSONArray("requests").mapObjects(TetherRequest::from)
        }
    }

    fun answer(requestId: String, answer: String): Result<Unit> {
        val request = authed("/api/requests/$requestId/answer")
            .post(json(JSONObject().put("answer", answer)))
            .build()
        return execute(request) { }
    }

    fun refuse(requestId: String): Result<Unit> {
        val request = authed("/api/requests/$requestId/answer")
            .post(json(JSONObject().put("refused", true)))
            .build()
        return execute(request) { }
    }

    /* -------------------------------------------------------------- calls -- */

    fun listCalls(): Result<List<CallSession>> {
        val request = authed("/api/calls").get().build()
        return execute(request, ::bodyJson).map { o ->
            o.optJSONArray("calls").mapObjects(CallSession::from)
        }
    }

    /* ---------------------------------------------------------- sessions -- */

    /** The home page: live sessions, each with its subagents nested. */
    fun listSessions(): Result<List<AgentSession>> {
        val request = authed("/api/sessions").get().build()
        return execute(request, ::bodyJson).map { o ->
            o.optJSONArray("sessions").mapObjects(AgentSession::from)
        }
    }

    fun sessionMessages(sessionId: String): Result<List<SessionMessage>> {
        val request = authed("/api/sessions/$sessionId/messages").get().build()
        return execute(request, ::bodyJson).map { o ->
            o.optJSONArray("messages").mapObjects(SessionMessage::from)
        }
    }

    /**
     * Queue a message for a session.
     *
     * A 409 means the server refused to accept it because nothing can carry it
     * — no relay, a subagent, or a session that has ended. That is a real
     * answer rather than a fault, and its body carries wording meant to be
     * shown as-is, so callers should surface [HttpError.body] rather than
     * inventing their own message.
     */
    fun sendToSession(sessionId: String, text: String): Result<SessionMessage> {
        val request = authed("/api/sessions/$sessionId/messages")
            .post(json(JSONObject().put("text", text)))
            .build()
        return execute(request, ::bodyJson).map(SessionMessage::from)
    }

    /**
     * Pick up.
     *
     * A 409 here is normal rather than exceptional: every paired device rings
     * and only one can win. Callers should treat [HttpError] with code 409 as
     * "answered elsewhere" and dismiss quietly.
     */
    fun answerCall(callId: String): Result<List<CallSegment>> {
        val request = authed("/api/calls/$callId/answer").post(EMPTY).build()
        return execute(request, ::bodyJson).map { o ->
            o.optJSONArray("segments").mapObjects(CallSegment::from)
        }
    }

    fun declineCall(callId: String): Result<Unit> {
        val request = authed("/api/calls/$callId/decline").post(EMPTY).build()
        return execute(request) { }
    }

    /**
     * The caller's turn: what they said, and the recording of them saying it.
     *
     * Both are sent when both exist. The text is the phone's own live draft, so
     * the agent can start thinking immediately; the audio is what a server-side
     * model transcribes properly, and what ends up archived against the call.
     * Under the device provider the draft is simply the answer.
     *
     * Base64 in JSON rather than multipart: an utterance is a few hundred
     * kilobytes on a LAN, and one body shape is far less to get wrong than two.
     */
    fun postUtterance(callId: String, text: String, audio: ByteArray?, mime: String): Result<Unit> {
        val payload = JSONObject().put("mime", mime)
        if (text.isNotBlank()) payload.put("text", text)
        if (audio != null && audio.isNotEmpty()) {
            payload.put("audio", Base64.encodeToString(audio, Base64.NO_WRAP))
        }
        val request = authed("/api/calls/$callId/utterance").post(json(payload)).build()
        return execute(request) { }
    }

    fun endCall(callId: String): Result<Unit> {
        val request = authed("/api/calls/$callId/end").post(EMPTY).build()
        return execute(request) { }
    }

    /**
     * Fetch call audio.
     *
     * A call's opening line arrives as a `/v/:id/:token` URL that already
     * carries the request's single-purpose action token, and needs no header.
     * Every turn after it is an ordinary API path that does need one.
     *
     * The credential is attached on exactly one condition: the URL is on a
     * server this device is paired to. That test spans every known address,
     * because a push sent while the phone was at home carries a LAN URL that is
     * still perfectly ours when the phone answers over the tunnel — and it is
     * then rebased onto whichever address actually reaches it.
     *
     * A URL pointing anywhere else gets no header and no failover, because that
     * would be handing the device token to whoever wrote the payload.
     */
    fun fetchAudio(audioUrl: String): Result<ByteArray> {
        val ours = prefs.addresses.any { audioUrl.startsWith(it, ignoreCase = true) }
        val builder = Request.Builder().url(audioUrl)
        if (ours) builder.header("Authorization", "Bearer ${prefs.clientToken}")
        val request = builder.get().build()
        val body = { res: Response -> res.body?.bytes() ?: ByteArray(0) }
        return if (ours) execute(request, body) else executeOnce(request, parse = body)
    }

    class HttpError(val code: Int, val body: String) :
        IOException("HTTP $code: ${body.take(200)}")

    private companion object {
        val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
        val EMPTY = ByteArray(0).toRequestBody(null, 0, 0)
    }
}

private fun <T> JSONArray?.mapObjects(parse: (JSONObject) -> T): List<T> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { i -> optJSONObject(i)?.let(parse) }
}
