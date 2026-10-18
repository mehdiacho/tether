package tech.mehdiacho.tether.data

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray

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
 *
 * ## One server, several addresses
 *
 * A server is not an address. The same machine is `192.168.0.2` from the sofa
 * and `100.79.15.57` over the tunnel, and the token is valid at both because it
 * authenticates the *device*, not the route. Storing a single address made the
 * app unusable the moment the network changed, which is precisely when a tool
 * for reaching a stuck agent matters most.
 *
 * So [addresses] is an ordered list and the head is whichever one last worked.
 * [promote] moves a working address to the front, so the app converges on the
 * right route on its own rather than paying the failover cost on every request.
 */
class Prefs(context: Context) {

    private val sp: SharedPreferences =
        context.applicationContext.getSharedPreferences("tether", Context.MODE_PRIVATE)

    /** A human label, so the settings screen says "NAS" rather than an IP. */
    var serverName: String
        get() = sp.getString(KEY_NAME, "") ?: ""
        set(value) = sp.edit().putString(KEY_NAME, value.trim()).apply()

    /**
     * Every address known to reach this server, best first.
     *
     * Reading migrates a pre-0.2 install, which stored one address under a
     * different key. Doing it on read rather than in an init block means an
     * upgrade needs no migration step and cannot half-run.
     *
     * **Every branch normalises.** 0.2.0 shipped with the legacy branch
     * returning the stored value untouched, and a pre-0.2 install had stored a
     * bare `192.168.0.2:8790`. OkHttp does not fail that softly — `url()`
     * *throws* `IllegalArgumentException: Invalid URL port` while the request is
     * still being built, outside the runCatching around the call, so it came out
     * as an uncaught crash on the first refresh after launch rather than a
     * failed Result. The app crash-looped for two days. Normalising on write
     * only is not enough: the read is where an old value arrives.
     */
    var addresses: List<String>
        get() {
            val raw = sp.getString(KEY_ADDRESSES, null)
            if (raw.isNullOrBlank()) {
                val legacy = normalize(sp.getString(KEY_SERVER, "").orEmpty())
                return if (legacy.isBlank()) emptyList() else listOf(legacy)
            }
            return runCatching {
                val arr = JSONArray(raw)
                (0 until arr.length()).mapNotNull {
                    normalize(arr.optString(it)).takeIf(String::isNotBlank)
                }
            }.getOrDefault(emptyList())
        }
        set(value) {
            val clean = value.map { normalize(it) }.filter { it.isNotBlank() }.distinct()
            val arr = JSONArray().apply { clean.forEach { put(it) } }
            sp.edit()
                .putString(KEY_ADDRESSES, arr.toString())
                // Kept in step so anything still reading the old key — and any
                // older build the user rolls back to — still finds an address.
                .putString(KEY_SERVER, clean.firstOrNull().orEmpty())
                .apply()
        }

    /** The address currently in use: the head of the list. */
    var serverUrl: String
        get() = addresses.firstOrNull().orEmpty()
        set(value) = promote(value)

    /** Move an address to the front, adding it if it is new. */
    fun promote(address: String) {
        val clean = normalize(address)
        if (clean.isBlank()) return
        addresses = listOf(clean) + addresses.filterNot { it.equals(clean, ignoreCase = true) }
    }

    /** Add an address at the end. Returns false if it was already known. */
    fun addAddress(address: String): Boolean {
        val clean = normalize(address)
        if (clean.isBlank()) return false
        val current = addresses
        if (current.any { it.equals(clean, ignoreCase = true) }) return false
        addresses = current + clean
        return true
    }

    /**
     * Forget an address. Refuses to remove the last one, because a paired
     * server with no route is indistinguishable from being unpaired but far
     * more confusing — the token is still there and nothing says why it fails.
     */
    fun removeAddress(address: String): Boolean {
        val current = addresses
        if (current.size <= 1) return false
        val next = current.filterNot { it.equals(normalize(address), ignoreCase = true) }
        if (next.size == current.size) return false
        addresses = next
        return true
    }

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
        get() = addresses.isNotEmpty() && clientToken.isNotBlank()

    fun clear() {
        sp.edit().clear().apply()
    }

    private companion object {
        const val KEY_SERVER = "server_url"        // pre-0.2, single address
        const val KEY_ADDRESSES = "server_addresses"
        const val KEY_NAME = "server_name"
        const val KEY_TOKEN = "client_token"
        const val KEY_DEVICE = "device_id"
        const val KEY_PUSH = "reported_push_token"

        /**
         * A bare host is the overwhelmingly common thing to type, and rejecting
         * it teaches nothing. Assume http, since this is a LAN or tunnel address
         * far more often than a public HTTPS one.
         */
        fun normalize(raw: String): String {
            val t = raw.trim().trimEnd('/')
            if (t.isBlank()) return ""
            return if (t.startsWith("http://") || t.startsWith("https://")) t else "http://$t"
        }
    }
}
