package hub.core.android.phone

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import hub.core.android.BuildConfig
import hub.core.android.data.HubApis
import hub.core.client.model.ClientPlatform
import hub.core.client.model.Release
import hub.core.client.model.ReleaseChannel
import hub.core.client.model.UpdateCheck
import java.io.File
import java.security.MessageDigest

/**
 * Self-update where Android allows it (This device): the hub's `updates` channel says whether a
 * newer Android build exists; the app downloads it from the hub, checks its SHA-256 against the
 * release, and hands it to Android's package installer, which asks the person.
 */
object Updates {
    fun sha256(file: File): String = MessageDigest.getInstance("SHA-256").let { digest ->
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        digest.digest().joinToString("") { "%02x".format(it) }
    }

    suspend fun check(apis: HubApis): UpdateCheck =
        apis.updates.updatesCheck(ClientPlatform.ANDROID, ReleaseChannel.STABLE, BuildConfig.VERSION_NAME)

    /** The release's APK in the app's cache, or an exception when its bytes are not the release's. */
    suspend fun download(context: Context, apis: HubApis, release: Release): File {
        val downloaded = apis.updates.updatesDownload(release.id)
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val apk = File(dir, "corehub-${release.version}.apk")
        downloaded.copyTo(apk, overwrite = true)
        downloaded.delete()
        if (!sha256(apk).equals(release.sha256, ignoreCase = true)) {
            apk.delete()
            throw SecurityException("sha256 mismatch")
        }
        return apk
    }

    fun installIntent(context: Context, apk: File): Intent {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", apk)
        return Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
