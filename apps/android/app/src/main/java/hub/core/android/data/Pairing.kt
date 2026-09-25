package hub.core.android.data

import hub.core.android.generated.Product
import java.net.URI
import java.net.URLDecoder
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** The origin of a hub (`https://host[:port]`), or why the text is not one. */
sealed interface HubUrl {
    data class Ok(val origin: String) : HubUrl
    data object Invalid : HubUrl

    companion object {
        /**
         * Accepts what a person types: `hub.example.com`, `http://10.0.0.5:8787/`, a pasted
         * page address. The scheme defaults to https; a path, a query or credentials are not
         * a hub's address and are refused rather than silently dropped.
         */
        fun parse(raw: String): HubUrl {
            val text = raw.trim()
            if (text.isEmpty() || text.any { it.isWhitespace() }) return Invalid
            val withScheme = if ("://" in text) text else "https://$text"
            val uri = runCatching { URI(withScheme) }.getOrNull() ?: return Invalid
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return Invalid
            val host = uri.host ?: return Invalid
            if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return Invalid
            val path = uri.rawPath.orEmpty()
            if (path.isNotEmpty() && path != "/") return Invalid
            val port = if (uri.port == -1) "" else ":${uri.port}"
            return Ok("$scheme://${host.lowercase()}$port")
        }
    }
}

/** A pairing the hub drew as a QR (or sent as a `corehub://pair` link) for this device to claim. */
data class PairingRequest(val hub: String, val pairingId: String, val code: String)

object PairingInput {
    private val ULID = Regex("^[0-9A-HJKMNP-TV-Z]{26}$")
    private val CODE = Regex("^[A-Za-z0-9-]{4,32}$")

    internal fun request(hub: String?, id: String?, code: String?): PairingRequest? {
        if (hub == null || id == null || code == null) return null
        val origin = HubUrl.parse(hub) as? HubUrl.Ok ?: return null
        val pairingId = id.trim().uppercase()
        val trimmed = code.trim().uppercase()
        if (!ULID.matches(pairingId) || !CODE.matches(trimmed)) return null
        return PairingRequest(origin.origin, pairingId, trimmed)
    }

    /**
     * The QR's JSON (`{"type":"corehub.pairing", "hub_url", "pairing_id", "code", "expires_at"}`,
     * or `majlis.pairing` from a hub older than the rename) or a `corehub://pair?hub=&id=&code=`
     * link. Anything else — another app's QR, an expired code — is null.
     */
    fun parse(raw: String, now: Instant = Instant.now()): PairingRequest? {
        val text = raw.trim()
        if (text.startsWith("{")) {
            val obj = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
            fun str(key: String) = (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
            val type = str("type")
            if (type != Product.PAIRING_TYPE && type != Product.LEGACY_PAIRING_TYPE) return null
            val expires = str("expires_at")?.let { runCatching { Instant.parse(it) }.getOrNull() }
            if (expires != null && expires.isBefore(now)) return null
            return request(str("hub_url"), str("pairing_id"), str("code"))
        }
        return (DeepLink.parse(text) as? DeepLink.Pair)?.request
    }
}

/** `corehub://` links, the same three the desktop app accepts. */
sealed interface DeepLink {
    data class Pair(val request: PairingRequest) : DeepLink
    data class Connect(val hub: String) : DeepLink
    data class Open(val path: String) : DeepLink

    companion object {
        private val APP_PATH = Regex("^/(?!/)[A-Za-z0-9\\-._~/%]*(\\?[A-Za-z0-9\\-._~%=&+]*)?$")

        fun parse(raw: String): DeepLink? {
            val uri = runCatching { URI(raw.trim()) }.getOrNull() ?: return null
            if (uri.scheme?.lowercase() != Product.SCHEME) return null
            // `corehub://pair?…` has authority `pair`; `corehub:pair?…` is opaque.
            val specific = uri.rawSchemeSpecificPart.orEmpty().removePrefix("//")
            val beforeQuery = specific.substringBefore('?')
            val query = if ('?' in specific) specific.substringAfter('?') else ""
            val parts = beforeQuery.trim('/').split('/')
            val params = query.split('&').filter { it.isNotEmpty() }.associate {
                val k = it.substringBefore('=')
                val v = URLDecoder.decode(it.substringAfter('=', ""), "UTF-8")
                k to v
            }
            return when (parts.firstOrNull()) {
                "pair" -> PairingInput.request(params["hub"], params["id"], params["code"])?.let { Pair(it) }
                "connect" -> (HubUrl.parse(params["hub"].orEmpty()) as? HubUrl.Ok)?.let { Connect(it.origin) }
                "open" -> {
                    val path = "/" + parts.drop(1).joinToString("/") + if (query.isEmpty()) "" else "?$query"
                    if (APP_PATH.matches(path) && ".." !in path.split('/', '?')) Open(path) else null
                }
                else -> null
            }
        }
    }
}
