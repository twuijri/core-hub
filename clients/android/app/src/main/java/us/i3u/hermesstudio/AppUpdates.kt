package us.i3u.hermesstudio

import org.json.JSONObject

/**
 * The arithmetic behind the in-app update, with nothing Android in it.
 *
 * Core Hub Mobile does not ask GitHub for its own builds: the release is
 * private, and a GitHub token has no business sitting on a phone. The app asks
 * the owner's own Core Hub instead, which proxies the release
 * (`GET /api/studio/app-updates/mobile` and the download path it names), with
 * the same bearer token and `X-Hermes-Profile` header every other call carries.
 *
 * Everything that can be wrong without a server — a build compared as a string,
 * a check that runs on every resume, a resumed download that appends at the
 * wrong offset — is decided by the pure functions here, so
 * `AppUpdateVersionTest`, `AppUpdateThrottleTest` and `AppUpdateParseTest` can
 * prove them without a device.
 */

/** The channel a build with no `-<channel>.<n>` suffix is assumed to be on. */
const val UPDATE_DEFAULT_CHANNEL = "test"

/**
 * One build, split the way CI names them: `1.0.2-test.22` is release `1.0.2`,
 * channel `test`, build 22.
 *
 * The build number is the part that actually orders two builds of the same
 * release, and it is a number: `1.0.2-test.9` is older than `1.0.2-test.22`,
 * which string comparison gets backwards.
 */
data class AppBuild(
    /** The release part, e.g. `1.0.2`. */
    val version: String,
    val buildNumber: Int,
    val channel: String,
) {
    /** How the build is named as a whole, the way CI wrote it. */
    val name: String get() = if (channel.isBlank()) version else "$version-$channel.$buildNumber"

    /**
     * True when this build really is ahead of [other]: a higher release, or
     * the same release with a higher build number. Identical builds are not
     * newer, which is what stops the app offering the owner what he is running.
     */
    fun isNewerThan(other: AppBuild): Boolean {
        val release = compareVersions(version, other.version)
        if (release != 0) return release > 0
        return buildNumber > other.buildNumber
    }

    companion object {
        /**
         * Reads a build out of a version name. [fallbackBuildNumber] (normally
         * `BuildConfig.VERSION_CODE`, or the server's `buildNumber`) is used
         * when the name carries no `.<n>` suffix, so a plain `1.4.0` local
         * build still has an order.
         */
        fun parse(
            versionName: String,
            fallbackBuildNumber: Int = 0,
            fallbackChannel: String = UPDATE_DEFAULT_CHANNEL,
        ): AppBuild {
            val trimmed = versionName.trim()
            val release = trimmed.substringBefore('-').trim().ifBlank { "0" }
            val suffix = trimmed.substringAfter('-', "").trim()
            val channel = suffix.substringBefore('.').trim().ifBlank { fallbackChannel }
            val build = suffix.substringAfter('.', "").trim().toIntOrNull() ?: fallbackBuildNumber
            return AppBuild(release, build, channel)
        }

        /** This install, as [BuildConfig] names it. */
        fun installed(): AppBuild = parse(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE)
    }
}

/**
 * Compares two dotted releases segment by segment, as numbers. A segment that
 * is not a number counts as 0 rather than throwing, and a missing segment
 * counts as 0 so `1.2` and `1.2.0` are the same release.
 */
fun compareVersions(left: String, right: String): Int {
    val a = left.split('.')
    val b = right.split('.')
    for (index in 0 until maxOf(a.size, b.size)) {
        val one = a.getOrNull(index)?.trim()?.toIntOrNull() ?: 0
        val two = b.getOrNull(index)?.trim()?.toIntOrNull() ?: 0
        if (one != two) return one.compareTo(two)
    }
    return 0
}

/** A build the server is offering, with everything needed to fetch and verify it. */
data class MobileRelease(
    /** The server's own name for it, e.g. `1.0.2-test.23`. */
    val versionName: String,
    val build: AppBuild,
    val notes: String,
    /** The APK's length as the server knows it; 0 when it did not say. */
    val sizeBytes: Long,
    val publishedAt: String,
    /** Path on the owner's Core Hub, not an absolute URL to anywhere else. */
    val downloadPath: String,
)

/**
 * Why an update is not on offer. Every branch has its own Arabic and English
 * message, because "update failed" tells the owner nothing about whether to
 * fix his server, his network or his phone.
 */
enum class UpdateProblem {
    /** HTTP 200 `{available:false, reason:'not_configured'}`, or a 409 on the download. */
    NotConfigured,

    /** The request never reached the server. */
    NoNetwork,

    /** 401 or 403: the token or the profile is not allowed to read releases. */
    Unauthorized,

    /** Any other HTTP failure, or an unreadable body. */
    ServerError,

    /** `available:true` with no version or no download path. */
    Malformed,

    /** The stream ended before the expected number of bytes arrived. */
    DownloadIncomplete,

    /** Android will not install from this app until the owner allows it. */
    InstallPermission,

    /** The package installer came back without installing. */
    InstallCancelled,

    /** The owner stopped the download himself. */
    Cancelled,
}

/** What a check concluded. */
sealed interface UpdateCheckResult {
    data class Available(val release: MobileRelease) : UpdateCheckResult
    data object UpToDate : UpdateCheckResult
    data class Unavailable(val problem: UpdateProblem, val detail: String? = null) : UpdateCheckResult
}

/**
 * Turns `GET /api/studio/app-updates/mobile` into a verdict.
 *
 * The contract is narrow on purpose: HTTP 200 always, with `available` deciding
 * everything, and `reason: 'not_configured'` for the case the owner has simply
 * not pointed his server at a release yet. An `available:true` body that names
 * no version or no download path is a broken server, not an update, so it is
 * reported rather than followed.
 */
fun parseMobileUpdate(body: JSONObject, installed: AppBuild): UpdateCheckResult {
    val available = body.optBoolean("available", false)
    if (!available) {
        val reason = body.optString("reason").trim()
        return when {
            reason.isBlank() -> UpdateCheckResult.UpToDate
            reason == "not_configured" -> UpdateCheckResult.Unavailable(UpdateProblem.NotConfigured)
            else -> UpdateCheckResult.Unavailable(UpdateProblem.ServerError, reason)
        }
    }
    val versionName = body.optString("version").trim()
    val downloadPath = body.optString("downloadPath").trim()
    if (versionName.isBlank() || downloadPath.isBlank()) {
        return UpdateCheckResult.Unavailable(UpdateProblem.Malformed)
    }
    val declaredBuild = body.optInt("buildNumber", 0)
    val offered = AppBuild.parse(versionName, declaredBuild, installed.channel)
        // A `buildNumber` field and a `-test.<n>` suffix should agree; when the
        // field is present it wins, because it is the one the contract names.
        .let { if (declaredBuild > 0) it.copy(buildNumber = declaredBuild) else it }
    if (!offered.isNewerThan(installed)) return UpdateCheckResult.UpToDate
    return UpdateCheckResult.Available(
        MobileRelease(
            versionName = versionName,
            build = offered,
            notes = body.optString("notes").trim(),
            sizeBytes = body.optLong("sizeBytes", 0L).coerceAtLeast(0L),
            publishedAt = body.optString("publishedAt").trim(),
            downloadPath = downloadPath,
        ),
    )
}

/**
 * What the last check, download or install ended as — the one thing the
 * Settings row has to be able to say out loud, including "you are up to date"
 * and every failure with its own reason.
 *
 * The name is what [Store.updateOutcome] persists, so it survives a restart
 * and Settings can answer before any new check has run. [detailRes] marks the
 * outcomes that take one argument.
 */
enum class UpdateOutcome(val messageRes: Int, val takesDetail: Boolean = false) {
    Never(R.string.update_last_never),
    UpToDate(R.string.update_last_up_to_date),
    UpdateFound(R.string.update_last_found, takesDetail = true),
    SkippedMetered(R.string.update_last_metered),
    NotConfigured(R.string.update_error_not_configured),
    NoNetwork(R.string.update_error_no_network),
    Unauthorized(R.string.update_error_unauthorized),
    ServerError(R.string.update_error_server, takesDetail = true),
    Malformed(R.string.update_error_malformed),
    DownloadIncomplete(R.string.update_error_incomplete),
    InstallPermission(R.string.update_error_install_permission),
    InstallCancelled(R.string.update_error_install_cancelled),
    Cancelled(R.string.update_error_cancelled);

    companion object {
        /** Reads back what [Store.updateOutcome] wrote, forgiving an unknown name. */
        fun named(value: String): UpdateOutcome =
            entries.firstOrNull { it.name == value } ?: Never
    }
}

/** Every problem has exactly one outcome; no failure falls through unnamed. */
fun UpdateProblem.outcome(): UpdateOutcome = when (this) {
    UpdateProblem.NotConfigured -> UpdateOutcome.NotConfigured
    UpdateProblem.NoNetwork -> UpdateOutcome.NoNetwork
    UpdateProblem.Unauthorized -> UpdateOutcome.Unauthorized
    UpdateProblem.ServerError -> UpdateOutcome.ServerError
    UpdateProblem.Malformed -> UpdateOutcome.Malformed
    UpdateProblem.DownloadIncomplete -> UpdateOutcome.DownloadIncomplete
    UpdateProblem.InstallPermission -> UpdateOutcome.InstallPermission
    UpdateProblem.InstallCancelled -> UpdateOutcome.InstallCancelled
    UpdateProblem.Cancelled -> UpdateOutcome.Cancelled
}

/**
 * The HTTP status a failed call came back with, as a problem.
 *
 * A transport failure never reached the server and is a network problem; 401
 * and 403 are the token or the profile; a 409 `updates_not_configured` on the
 * download is the same "not configured" the check reports as HTTP 200.
 */
fun updateProblemFor(statusCode: Int?, code: String?, transportFailure: Boolean): UpdateProblem = when {
    transportFailure -> UpdateProblem.NoNetwork
    code == "updates_not_configured" -> UpdateProblem.NotConfigured
    statusCode == 401 || statusCode == 403 -> UpdateProblem.Unauthorized
    statusCode == 409 -> UpdateProblem.NotConfigured
    else -> UpdateProblem.ServerError
}

/**
 * When an automatic check is allowed to run.
 *
 * Two rules, both the owner's: no more than once every few hours, and never on
 * a metered connection unless he asks. "Asking" is the Settings row, which
 * passes `manual = true` and skips both.
 */
object UpdateThrottle {

    /** Six hours between automatic checks — start and resume both go through here. */
    const val INTERVAL_MS: Long = 6L * 60 * 60 * 1000

    fun shouldCheck(
        now: Long,
        lastCheckAt: Long,
        metered: Boolean,
        manual: Boolean = false,
        allowMetered: Boolean = false,
        intervalMs: Long = INTERVAL_MS,
    ): Boolean {
        if (manual) return true
        if (metered && !allowMetered) return false
        if (lastCheckAt <= 0L) return true
        // A clock that moved backwards (or a restored backup) must not lock the
        // owner out of updates until the stored stamp comes round again.
        if (lastCheckAt > now) return true
        return now - lastCheckAt >= intervalMs
    }
}

/**
 * Everything the update notice and the Settings row read.
 *
 * The notice is a card in the same stack as the other notices above the
 * composer — deliberately not a dialog, because an update is never urgent
 * enough to stand between the owner and his chat.
 */
data class UpdateUiState(
    /** The build on offer, or null when there is nothing newer. */
    val release: MobileRelease? = null,
    val checking: Boolean = false,
    val downloading: Boolean = false,
    val downloadedBytes: Long = 0L,
    val totalBytes: Long = 0L,
    /** Absolute path of a verified APK waiting for the package installer. */
    val readyApkPath: String? = null,
    /** The owner waved this build away; it does not come back on the next resume. */
    val dismissed: Boolean = false,
    val outcome: UpdateOutcome = UpdateOutcome.Never,
    val outcomeDetail: String = "",
    val checkedAt: Long = 0L,
    /** Android has to allow this app as an install source before anything else. */
    val needsInstallPermission: Boolean = false,
) {
    val showNotice: Boolean get() = release != null && !dismissed
    val percent: Int get() = UpdateDownload.percent(downloadedBytes, totalBytes)
}

/**
 * The offsets of a resumable download.
 *
 * The APK is written into the app's own cache, so a download interrupted by a
 * dead network or a killed app can carry on with `Range: bytes=<n>-` instead of
 * starting again. Every number below is one the download gets wrong silently if
 * it is wrong at all — an APK that is short by a few bytes still looks like a
 * file — so they live here and are tested.
 */
object UpdateDownload {

    /**
     * How many cached bytes can be kept. A cache longer than the release
     * itself is a leftover from another build and is thrown away.
     */
    fun startOffset(existingBytes: Long, expectedTotal: Long): Long = when {
        existingBytes <= 0L -> 0L
        expectedTotal > 0L && existingBytes > expectedTotal -> 0L
        else -> existingBytes
    }

    /** The `Range` header for an offset, or null when starting from the top. */
    fun rangeHeader(offset: Long): String? = if (offset > 0L) "bytes=$offset-" else null

    /**
     * Where the body that came back must be written.
     *
     * 206 means the server honoured the range and the body continues at the
     * offset asked for. Anything else — including a 200 from a server that
     * ignored the header — is the whole file again, so it overwrites from 0.
     */
    fun writeOffset(responseCode: Int, requestedOffset: Long): Long =
        if (responseCode == 206) requestedOffset else 0L

    /**
     * The full length of the APK. The check's `sizeBytes` is preferred; failing
     * that, a 206's body length is added to the offset it started at and a
     * 200's body length is the whole thing.
     */
    fun expectedTotal(
        declaredSize: Long,
        responseCode: Int,
        bodyLength: Long,
        requestedOffset: Long,
    ): Long {
        if (declaredSize > 0L) return declaredSize
        if (bodyLength <= 0L) return 0L
        return if (responseCode == 206) requestedOffset + bodyLength else bodyLength
    }

    /** True only when the file on disk is exactly as long as the release. */
    fun isComplete(bytesOnDisk: Long, expectedTotal: Long): Boolean =
        expectedTotal > 0L && bytesOnDisk == expectedTotal

    /** 0–100 for the progress bar; 0 while the total is unknown. */
    fun percent(downloaded: Long, total: Long): Int {
        if (total <= 0L) return 0
        return ((downloaded.coerceAtLeast(0L) * 100) / total).coerceIn(0L, 100L).toInt()
    }
}
