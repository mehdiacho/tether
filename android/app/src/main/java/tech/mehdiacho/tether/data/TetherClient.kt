package tech.mehdiacho.tether.data

import android.content.Context
import android.util.Base64
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

    val baseUrl: String get() = prefs.serverUrl
    val isPaired: Boolean get() = prefs.isPaired

    private fun url(path: String) = "${prefs.serverUrl}$path"

    private fun authed(path: String): Request.Builder =
        Request.Builder()
            .url(url(path))
            .header("Authorization", "Bearer ${prefs.clientToken}")

    private fun json(body: JSONObject) =
        body.toString().toRequestBody(JSON_MEDIA)

    private fun <T> execute(request: Request, parse: (Response) -> T): Result<T> =
        runCatching {
            http.newCall(request).execute().use { res ->
                if (!res.isSuccessful) {
                    throw HttpError(res.code, res.body?.string().orEmpty())
                }
                parse(res)
            }
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

        return execute(request, ::bodyJson).map { o ->
            prefs.serverUrl = clean
            prefs.clientToken = o.optString("clientToken")
            prefs.deviceId = o.optString("deviceId")
            prefs.reportedPushToken = pushToken.orEmpty()
        }
    }

    fun unpair() = prefs.clear()

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
     * The credential is attached on exactly one condition: the URL is on the
     * server this device is paired to. A URL that arrived over push pointing
     * anywhere else gets no header, because that would be handing the device
     * token to whoever wrote the payload.
     */
    fun fetchAudio(audioUrl: String): Result<ByteArray> {
        val ours = prefs.serverUrl.isNotBlank() && audioUrl.startsWith(prefs.serverUrl)
        val request =
            if (ours) Request.Builder().url(audioUrl)
                .header("Authorization", "Bearer ${prefs.clientToken}").get().build()
            else Request.Builder().url(audioUrl).get().build()
        return execute(request) { it.body?.bytes() ?: ByteArray(0) }
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
