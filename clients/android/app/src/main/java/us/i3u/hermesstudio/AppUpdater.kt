package us.i3u.hermesstudio

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

/**
 * The Android half of the in-app update: where the APK is cached, whether the
 * connection is one the owner wants downloads on, and how the file reaches the
 * package installer.
 *
 * The network contract lives in [HermesApi.mobileUpdate] and
 * [HermesApi.downloadMobileUpdate]; the arithmetic lives in `AppUpdates.kt`.
 * What is left here is the part that needs a [Context] and therefore cannot be
 * unit tested — deliberately kept thin for that reason.
 */
object AppUpdater {

    /** Cached APKs live here, inside the app's own cache; see `res/xml/file_paths.xml`. */
    private const val CACHE_DIRECTORY = "updates"

    /**
     * One file per build, named after the version, so a resumed download can
     * never append this build's bytes onto the tail of another one.
     */
    fun cacheFile(context: Context, release: MobileRelease): File {
        val directory = File(context.cacheDir, CACHE_DIRECTORY).apply { mkdirs() }
        val safe = release.versionName.replace(Regex("[^A-Za-z0-9._-]"), "_")
        return File(directory, "core-hub-$safe.apk")
    }

    /** Drops every cached APK except the one being worked on. */
    fun pruneCache(context: Context, keep: File?) {
        File(context.cacheDir, CACHE_DIRECTORY).listFiles().orEmpty().forEach { file ->
            if (file.isFile && file.absolutePath != keep?.absolutePath) file.delete()
        }
    }

    /** Forgets a half-finished download, so the next attempt starts clean. */
    fun discard(file: File?) {
        file?.takeIf { it.isFile }?.delete()
    }

    /**
     * True when the active connection is metered — mobile data, or a hotspot
     * the owner marked as metered. An automatic check stays off it; a check he
     * asked for in Settings does not care.
     */
    fun isMetered(context: Context): Boolean {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val network = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    /** True when there is no usable connection at all. */
    fun isOffline(context: Context): Boolean {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val network = manager.activeNetwork ?: return true
        val capabilities = manager.getNetworkCapabilities(network) ?: return true
        return !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /**
     * Whether Android will let this app hand over an APK at all. Since Oreo
     * the `REQUEST_INSTALL_PACKAGES` permission in the manifest is only half
     * of it: the owner also has to allow this app as an install source once,
     * per app, in system settings.
     */
    fun canInstall(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

    /**
     * The system screen where the owner allows this app to install packages.
     * Sent with the package in the URI so it opens on Core Hub's own row
     * rather than the full list of apps.
     */
    fun unknownSourcesIntent(context: Context): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /**
     * The package-installer intent for a downloaded APK.
     *
     * The file never leaves the app's cache: [FileProvider] hands the
     * installer a one-time `content://` URI instead of a path, which is why
     * the provider and its `updates/` cache path are declared in the manifest.
     *
     * `ACTION_INSTALL_PACKAGE` with `EXTRA_RETURN_RESULT` is used rather than
     * `ACTION_VIEW` because it reports back: without a result there is no way
     * to tell an install the owner cancelled from one that silently failed,
     * and both would be reported as nothing at all.
     */
    fun installIntent(context: Context, apk: File): Intent {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
        @Suppress("DEPRECATION")
        return Intent(Intent.ACTION_INSTALL_PACKAGE)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .putExtra(Intent.EXTRA_RETURN_RESULT, true)
            .putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
}
