package hub.core.android.phone

import android.content.Context
import android.os.Build
import android.provider.Settings
import hub.core.android.BuildConfig
import hub.core.client.model.PushBlocker

/**
 * What this phone tells the hub about itself, so the web's device card can tell two phones
 * apart (docs/changes/2026-09-26-twuijri-device-cards.md): the name the person gave the phone
 * in Android's settings, the maker and model, the Android version and the app's version. Sent
 * when pairing or registering, and again at each launch (`devices.update`).
 */
data class DeviceInfo(
    val name: String,
    val brand: String?,
    val model: String?,
    val osVersion: String?,
    val appVersion: String?,
)

object DeviceInfos {
    /**
     * The pure part, tested (DeviceInfoTest). `samsung` reads `Samsung`; a model that already
     * says its maker ("Xiaomi 14") is not prefixed again; the person's own name for the phone
     * wins, and without one the phone is its maker and model.
     */
    fun describe(
        manufacturer: String?,
        model: String?,
        release: String?,
        versionName: String?,
        personName: String?,
    ): DeviceInfo {
        val brand = manufacturer?.trim()?.takeIf { it.isNotEmpty() }?.let {
            if (it == it.lowercase()) it.replaceFirstChar { c -> c.titlecase() } else it
        }
        val cleanModel = model?.trim()?.takeIf { it.isNotEmpty() }
        val fallback = when {
            cleanModel == null -> brand ?: "Android"
            brand == null || cleanModel.contains(brand, ignoreCase = true) -> cleanModel
            else -> "$brand $cleanModel"
        }
        return DeviceInfo(
            name = (personName?.trim()?.takeIf { it.isNotEmpty() } ?: fallback).take(80),
            brand = brand?.take(80),
            model = cleanModel?.take(120),
            osVersion = release?.trim()?.takeIf { it.isNotEmpty() }?.take(64),
            appVersion = versionName?.trim()?.takeIf { it.isNotEmpty() }?.take(32),
        )
    }

    /** This phone, now. The person's name for it needs a context (Settings.Global). */
    fun current(context: Context? = null): DeviceInfo = describe(
        manufacturer = Build.MANUFACTURER,
        model = Build.MODEL,
        release = Build.VERSION.RELEASE,
        versionName = BuildConfig.VERSION_NAME,
        personName = context?.let {
            runCatching { Settings.Global.getString(it.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
        },
    )

    /**
     * What stops push on this phone, as the hub's `PushBlocker`: a build without Firebase cannot
     * receive it at all; otherwise it is the notification permission — not asked yet (Android
     * 13+ asks once after sign-in), or refused / turned off in the system settings.
     */
    fun pushBlocker(inBuild: Boolean, notificationsAllowed: Boolean, asked: Boolean, sdk: Int): PushBlocker = when {
        !inBuild -> PushBlocker.NOT_IN_BUILD
        notificationsAllowed -> PushBlocker.NONE
        sdk >= 33 && !asked -> PushBlocker.PERMISSION_PENDING
        else -> PushBlocker.PERMISSION_DENIED
    }
}
