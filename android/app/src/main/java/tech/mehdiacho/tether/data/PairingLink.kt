package tech.mehdiacho.tether.data

import android.net.Uri

/**
 * Everything a phone needs to pair: where the server is, and a code proving
 * someone with access authorised this device.
 */
data class PairingLink(val url: String, val code: String)

/**
 * Parse a scanned QR payload, or a link tapped from outside the app.
 *
 * The format is `tether://pair?v=1&u=<server url>&c=<code>` — a custom scheme
 * rather than an https link, so nothing here is meaningful to a browser and a
 * scanner cannot mistake it for a page to open.
 *
 * Unknown versions are accepted rather than rejected: every field this app
 * needs is already present, and refusing a payload because it carries a field
 * from a newer server would be a needless dead end. A version that genuinely
 * breaks compatibility can change the host instead.
 */
fun parsePairingPayload(raw: String): PairingLink? {
    val text = raw.trim()
    if (!text.startsWith(SCHEME, ignoreCase = true)) return null

    val uri = runCatching { Uri.parse(text) }.getOrNull() ?: return null
    if (!uri.host.equals(HOST, ignoreCase = true)) return null

    val url = uri.getQueryParameter("u")?.trim()?.trimEnd('/').orEmpty()
    val code = uri.getQueryParameter("c")?.trim()?.uppercase().orEmpty()
    if (url.isEmpty() || code.isEmpty()) return null

    // A payload pointing anywhere but an http(s) server is either a typo or an
    // attempt to get this device to send its pairing claim somewhere strange.
    if (!url.startsWith("http://", true) && !url.startsWith("https://", true)) return null

    return PairingLink(url = url, code = code)
}

/**
 * True if the text looks like a bare pairing code rather than a full link —
 * `XXXX-XXXX`, possibly typed without the dash.
 *
 * Worth recognising so that scanning a code-only QR, or pasting one, fills the
 * code field instead of being reported as an unreadable payload.
 */
fun looksLikePairingCode(raw: String): Boolean {
    val cleaned = raw.trim().uppercase().replace("-", "")
    return cleaned.length == 8 && cleaned.all { it.isLetterOrDigit() }
}

/** Normalise a typed or scanned code to the `XXXX-XXXX` the server compares. */
fun normalizePairingCode(raw: String): String {
    val cleaned = raw.trim().uppercase().replace("-", "")
    return if (cleaned.length == 8) "${cleaned.take(4)}-${cleaned.drop(4)}" else raw.trim().uppercase()
}

private const val SCHEME = "tether://"
private const val HOST = "pair"
