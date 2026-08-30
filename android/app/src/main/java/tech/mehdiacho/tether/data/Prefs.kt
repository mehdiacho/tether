package tech.mehdiacho.tether.data

import android.content.Context
import android.content.SharedPreferences

/**
 * Everything the app needs to keep between launches: where the server is, and
 * the credential it was issued at pairing.
 *
 * Plain SharedPreferences, deliberately. EncryptedSharedPreferences sounds like
 * the right answer but its keys live in the same keystore an attacker with the
 * device already has, so it buys very little against a real threat while adding
 * a dependency that has repeatedly broken across Android versions. The
 * meaningful protection is that the token is device-scoped and revocable
 * server-side, which is a property of the design rather than of the file.
 */
class Prefs(context: Context) {

    private val sp: SharedPreferences =
        context.applicationContext.getSharedPreferences("tether", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString(KEY_SERVER, "") ?: ""
        set(value) = sp.edit().putString(KEY_SERVER, value.trimEnd('/')).apply()

    var clientToken: String
        get() = sp.getString(KEY_TOKEN, "") ?: ""
        set(value) = sp.edit().putString(KEY_TOKEN, value).apply()

    var deviceId: String
        get() = sp.getString(KEY_DEVICE, "") ?: ""
        set(value) = sp.edit().putString(KEY_DEVICE, value).apply()

    /**
     * The last FCM token we successfully told the server about.
     *
     * Kept so a routine app start doesn't re-POST an unchanged token, and so a
     * rotation that happens while the server is unreachable is retried on the
     * next launch instead of being lost.
     */
    var reportedPushToken: String
        get() = sp.getString(KEY_PUSH, "") ?: ""
        set(value) = sp.edit().putString(KEY_PUSH, value).apply()

    val isPaired: Boolean
        get() = serverUrl.isNotBlank() && clientToken.isNotBlank()

    fun clear() {
        sp.edit().clear().apply()
    }

    private companion object {
        const val KEY_SERVER = "server_url"
        const val KEY_TOKEN = "client_token"
        const val KEY_DEVICE = "device_id"
        const val KEY_PUSH = "reported_push_token"
    }
}
