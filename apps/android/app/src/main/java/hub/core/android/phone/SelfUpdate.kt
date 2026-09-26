package hub.core.android.phone

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.util.Locale

/**
 * The app finds a newer Core Hub by itself (owner, 2026-09-26: «يكتشفون التحديث اذا نزل تحديث»;
 * DECISIONS §108). The signed APK lives on the public repository's GitHub releases
 * (`publish-release.yml`), so the phone asks GitHub's `releases/latest` — no token, nothing sent
 * but the app's version in the User-Agent — when it comes to the front, at most every
 * [ReleaseRules.INTERVAL_MS], and whenever the person asks on This device. A newer version is
 * offered; "Update" downloads the APK, checks its size (and GitHub's SHA-256 when it gives one),
 * and hands it to Android's installer, which asks the person.
 *
 * A build for Google Play turns all of it off (`BuildConfig.SELF_UPDATE`, docs/RELEASING.md):
 * Play updates the app and forbids an app updating itself.
 */

/** A release this app could update to: its version and the APK on it. */
@Serializable
data class AppRelease(
    val version: String,
    val apkName: String,
    val apkUrl: String,
    /** The APK's size in bytes, as the release lists it; the download must match it. */
    val size: Long,
    /** The file's SHA-256 (hex) when GitHub lists a `digest` for it. */
    val sha256: String? = null,
    /** The release's page (its notes). */
    val pageUrl: String,
)

/** The rules, without Android or the network (unit-tested in SelfUpdateTest). */
object ReleaseRules {
    const val REPO = "twuijri/core-hub"

    /** At most one automatic check every six hours; This device can always ask now. */
    const val INTERVAL_MS = 6L * 60 * 60 * 1000

    /**
     * The release's APK, named by `apps/desktop/scripts/release-assets.mjs` (`Core-Hub-X.Y.Z-android.apk`)
     * — the same pattern as the download page (`site/src/releases.js`).
     */
    val APK_NAME = Regex("^Core-Hub-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?-android\\.apk$")

    private data class Version(val core: List<Long>, val pre: List<String>)

    private fun parse(text: String): Version? {
        val m = Regex("^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?$").matchEntire(text.trim()) ?: return null
        val core = (1..3).map { m.groupValues[it].toLongOrNull() ?: return null }
        return Version(core, m.groupValues[4].takeIf { it.isNotEmpty() }?.split('.') ?: emptyList())
    }

    fun isVersion(text: String): Boolean = parse(text) != null

    /** Semantic-version order: negative when [a] is older than [b]; 0 when either is not a version. */
    fun compare(a: String, b: String): Int {
        val x = parse(a) ?: return 0
        val y = parse(b) ?: return 0
        for (i in 0 until 3) if (x.core[i] != y.core[i]) return x.core[i].compareTo(y.core[i])
        // A release is newer than its own pre-releases (1.2.0 > 1.2.0-test.3).
        if (x.pre.isEmpty() && y.pre.isEmpty()) return 0
        if (x.pre.isEmpty()) return 1
        if (y.pre.isEmpty()) return -1
        for (i in 0 until maxOf(x.pre.size, y.pre.size)) {
            val p = x.pre.getOrNull(i) ?: return -1
            val q = y.pre.getOrNull(i) ?: return 1
            val pn = p.toLongOrNull()
            val qn = q.toLongOrNull()
            if (pn != null && qn != null) { if (pn != qn) return pn.compareTo(qn) }
            else if (pn != null) return -1
            else if (qn != null) return 1
            else if (p != q) return p.compareTo(q)
        }
        return 0
    }

    fun isNewer(candidate: String, current: String): Boolean =
        isVersion(candidate) && isVersion(current) && compare(candidate, current) > 0

    /** The APK among a release's assets: the right name, under this repository's release downloads, with a size. */
    fun pickApk(assets: JsonArray, repo: String = REPO): JsonObject? {
        val prefix = "https://github.com/$repo/releases/download/"
        return assets.filterIsInstance<JsonObject>().firstOrNull { asset ->
            val name = asset.string("name") ?: return@firstOrNull false
            val url = asset.string("browser_download_url") ?: return@firstOrNull false
            APK_NAME.matches(name) && url.startsWith(prefix) && (asset.long("size") ?: 0L) > 0L
        }
    }

    /**
     * What `GET /repos/{repo}/releases/latest` answered, as a release this app can install; null
     * for anything else (an error body, a draft, a pre-release, a tag that is not a version, no APK).
     */
    fun read(body: String, repo: String = REPO): AppRelease? {
        val json = runCatching { Json.parseToJsonElement(body) }.getOrNull() as? JsonObject ?: return null
        val tag = json.string("tag_name") ?: return null
        if (json.bool("draft") == true || json.bool("prerelease") == true) return null
        val version = tag.removePrefix("v")
        // A pre-release is never offered, even one GitHub calls "latest" by mistake.
        if (!isVersion(version) || version.contains('-')) return null
        val apk = pickApk(json["assets"] as? JsonArray ?: return null, repo) ?: return null
        val page = json.string("html_url")?.takeIf { it.startsWith("https://github.com/$repo/releases/") }
            ?: "https://github.com/$repo/releases/latest"
        val digest = apk.string("digest")?.takeIf { it.startsWith("sha256:") }?.removePrefix("sha256:")
            ?.takeIf { Regex("^[0-9a-fA-F]{64}$").matches(it) }
        return AppRelease(
            version = version,
            apkName = apk.string("name")!!,
            apkUrl = apk.string("browser_download_url")!!,
            size = apk.long("size")!!,
            sha256 = digest?.lowercase(),
            pageUrl = page,
        )
    }

    /** Whether an automatic check is due: never checked, the clock went back, or [INTERVAL_MS] passed. */
    fun isDue(lastCheckAt: Long, now: Long): Boolean =
        lastCheckAt <= 0L || now < lastCheckAt || now - lastCheckAt >= INTERVAL_MS

    /** What the notice offers: the newer release, unless the person said "Later" to that version. */
    fun notice(available: AppRelease?, skipped: String?): AppRelease? = available?.takeIf { it.version != skipped }

    /** "12.3 MB", "980 KB" — Latin digits in both languages, as every number in the apps. */
    fun formatSize(bytes: Long): String {
        if (bytes <= 0) return ""
        val mb = bytes / (1024.0 * 1024.0)
        return if (mb >= 1) String.format(Locale.ROOT, "%.1f MB", mb).replace(".0 MB", " MB")
        else "${maxOf(1L, bytes / 1024)} KB"
    }

    private fun JsonObject.string(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    private fun JsonObject.long(key: String) = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
    private fun JsonObject.bool(key: String) = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
}

/** What asking for the latest release gave. */
sealed interface Lookup {
    /** GitHub answered; [release] is null when it has nothing this app can install. */
    data class Answer(val release: AppRelease?) : Lookup

    /** GitHub said no for now (60 calls an hour per address without a token). */
    data object RateLimited : Lookup

    /** Offline, or an answer that was not GitHub's. */
    data object Unreachable : Lookup
}

fun interface ReleaseSource {
    suspend fun latest(): Lookup
}

/** `GET https://api.github.com/repos/twuijri/core-hub/releases/latest`, without a token. */
class GitHubReleases(
    private val client: OkHttpClient,
    private val appVersion: String,
    private val repo: String = ReleaseRules.REPO,
    private val api: String = "https://api.github.com",
) : ReleaseSource {
    override suspend fun latest(): Lookup = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$api/repos/$repo/releases/latest")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "CoreHub-Android/$appVersion")
            .build()
        try {
            client.newCall(request).execute().use { response ->
                when {
                    response.isSuccessful -> Lookup.Answer(ReleaseRules.read(response.body?.string().orEmpty(), repo))
                    response.code == 403 || response.code == 429 -> Lookup.RateLimited
                    // No release published yet.
                    response.code == 404 -> Lookup.Answer(null)
                    else -> Lookup.Unreachable
                }
            }
        } catch (e: IOException) {
            Lookup.Unreachable
        } catch (e: IllegalStateException) {
            Lookup.Unreachable
        }
    }
}

/** What the phone keeps between launches: when it last asked, the "Later" version, the newer release found. */
interface UpdateStore {
    var lastCheckAt: Long
    var skipped: String?
    var latest: AppRelease?
}

class MemoryUpdateStore : UpdateStore {
    override var lastCheckAt: Long = 0L
    override var skipped: String? = null
    override var latest: AppRelease? = null
}

class PrefsUpdateStore(private val prefs: android.content.SharedPreferences) : UpdateStore {
    override var lastCheckAt: Long
        get() = prefs.getLong(LAST, 0L)
        set(value) = prefs.edit().putLong(LAST, value).apply()
    override var skipped: String?
        get() = prefs.getString(SKIPPED, null)
        set(value) = prefs.edit().putString(SKIPPED, value).apply()
    override var latest: AppRelease?
        get() = prefs.getString(LATEST, null)?.let { runCatching { Json.decodeFromString(AppRelease.serializer(), it) }.getOrNull() }
        set(value) = prefs.edit().putString(LATEST, value?.let { Json.encodeToString(AppRelease.serializer(), it) }).apply()

    private companion object {
        const val LAST = "last_check_at"
        const val SKIPPED = "skipped_version"
        const val LATEST = "latest_release"
    }
}

enum class CheckResult { DISABLED, NOT_DUE, UP_TO_DATE, AVAILABLE, RATE_LIMITED, UNREACHABLE }

/**
 * Asks [source] for the latest release, at most every [ReleaseRules.INTERVAL_MS] on its own, and
 * keeps what it found in [store] so the notice survives a restart without asking again. With
 * [enabled] false (a Play build) it never asks and never offers anything.
 */
class UpdateChecker(
    val enabled: Boolean,
    private val current: String,
    private val store: UpdateStore,
    private val source: ReleaseSource,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val lock = Mutex()
    private val _available = MutableStateFlow(store.latest?.takeIf { enabled && ReleaseRules.isNewer(it.version, current) })

    /** The newer release, if one was found (whatever the person said to it). */
    val available: StateFlow<AppRelease?> = _available.asStateFlow()

    private val _skipped = MutableStateFlow(store.skipped)

    /** The version the person answered "Later" to. */
    val skipped: StateFlow<String?> = _skipped.asStateFlow()

    /** The app came to the front: ask when due. */
    suspend fun checkIfDue(): CheckResult = if (!enabled) CheckResult.DISABLED else lock.withLock {
        if (!ReleaseRules.isDue(store.lastCheckAt, now())) CheckResult.NOT_DUE else ask()
    }

    /** The person pressed "Check for updates". */
    suspend fun checkNow(): CheckResult = if (!enabled) CheckResult.DISABLED else lock.withLock { ask() }

    private suspend fun ask(): CheckResult = when (val answer = source.latest()) {
        is Lookup.Answer -> {
            store.lastCheckAt = now()
            val newer = answer.release?.takeIf { ReleaseRules.isNewer(it.version, current) }
            store.latest = newer
            _available.value = newer
            if (newer != null) CheckResult.AVAILABLE else CheckResult.UP_TO_DATE
        }
        // Counted as a check, so a rate-limited phone does not ask again at every return.
        Lookup.RateLimited -> {
            store.lastCheckAt = now()
            CheckResult.RATE_LIMITED
        }
        // Offline: asked again the next time the app comes to the front.
        Lookup.Unreachable -> CheckResult.UNREACHABLE
    }

    /** "Later": the notice stays away until a newer version than this one. */
    fun later(version: String) {
        store.skipped = version
        _skipped.value = version
    }
}

/** The downloaded file is not the release's (its size or SHA-256 differ); nothing is installed. */
class BadDownload(message: String) : Exception(message)

/** Downloads a release's APK into a folder the FileProvider shares (`res/xml/update_paths.xml`). */
class ApkDownloader(private val client: OkHttpClient) {
    private fun target(release: AppRelease, dir: File) = File(dir, "corehub-${release.version}.apk")

    /** The APK downloaded earlier for [release] (an "Update" that stopped at Android's setting), if whole. */
    fun ready(release: AppRelease, dir: File): File? =
        target(release, dir).takeIf { it.isFile && it.length() == release.size }

    /** Deletes every downloaded APK but [keep]'s (an installed update leaves its file behind). */
    fun clean(dir: File, keep: AppRelease?) {
        val name = keep?.let { target(it, dir).name }
        dir.listFiles()?.filter { it.name != name }?.forEach { it.delete() }
    }

    suspend fun download(release: AppRelease, dir: File, onProgress: (read: Long, total: Long) -> Unit): File = withContext(Dispatchers.IO) {
        dir.mkdirs()
        clean(dir, null)
        val part = File(dir, "corehub-${release.version}.apk.part")
        val request = Request.Builder().url(release.apkUrl).header("Accept", "application/octet-stream").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
            val body = response.body ?: throw IOException("empty body")
            var read = 0L
            part.outputStream().use { out ->
                body.byteStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        ensureActive()
                        val n = input.read(buffer)
                        if (n < 0) break
                        read += n
                        // Never more than the release said: a wrong file does not fill the phone.
                        if (read > release.size) break
                        out.write(buffer, 0, n)
                        onProgress(read, release.size)
                    }
                }
            }
            if (read != release.size || part.length() != release.size) {
                part.delete()
                throw BadDownload("size ${part.length()} != ${release.size}")
            }
        }
        release.sha256?.let { expected ->
            if (!Updates.sha256(part).equals(expected, ignoreCase = true)) {
                part.delete()
                throw BadDownload("sha256 mismatch")
            }
        }
        val apk = target(release, dir)
        if (!part.renameTo(apk)) {
            part.delete()
            throw IOException("rename failed")
        }
        apk
    }
}
