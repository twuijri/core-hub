package hub.core.android.phone

import hub.core.client.model.PushBlocker
import org.junit.Assert.assertEquals
import org.junit.Test

/** How this phone describes itself to the hub: its name, maker, model and versions, and what stops push. */
class DeviceInfoTest {
    @Test fun `the person's own name for the phone wins, and the rest is reported as is`() {
        val info = DeviceInfos.describe("Google", "Pixel 9", "16", "0.2.0", "Tariq's Pixel")
        assertEquals(DeviceInfo("Tariq's Pixel", "Google", "Pixel 9", "16", "0.2.0"), info)
    }

    @Test fun `without a name the phone is its maker and model, said once`() {
        assertEquals("Google Pixel 9", DeviceInfos.describe("Google", "Pixel 9", "16", "1", null).name)
        assertEquals("Xiaomi 14", DeviceInfos.describe("Xiaomi", "Xiaomi 14", "15", "1", " ").name)
        val samsung = DeviceInfos.describe("samsung", "SM-S928B", "14", "1", null)
        assertEquals("Samsung", samsung.brand)
        assertEquals("Samsung SM-S928B", samsung.name)
        assertEquals("Android", DeviceInfos.describe(null, null, null, null, null).name)
    }

    @Test fun `blank values are left out, and long ones fit the hub's limits`() {
        val info = DeviceInfos.describe("  ", "", " ", "", "x".repeat(200))
        assertEquals(null, info.brand)
        assertEquals(null, info.model)
        assertEquals(null, info.osVersion)
        assertEquals(null, info.appVersion)
        assertEquals(80, info.name.length)
    }

    @Test fun `what stops push is the build, then the permission, asked or not`() {
        assertEquals(PushBlocker.NOT_IN_BUILD, DeviceInfos.pushBlocker(inBuild = false, notificationsAllowed = true, asked = true, sdk = 35))
        assertEquals(PushBlocker.NONE, DeviceInfos.pushBlocker(inBuild = true, notificationsAllowed = true, asked = false, sdk = 35))
        assertEquals(PushBlocker.PERMISSION_PENDING, DeviceInfos.pushBlocker(inBuild = true, notificationsAllowed = false, asked = false, sdk = 33))
        assertEquals(PushBlocker.PERMISSION_DENIED, DeviceInfos.pushBlocker(inBuild = true, notificationsAllowed = false, asked = true, sdk = 33))
        // Before Android 13 nothing is asked: notifications off means the person turned them off.
        assertEquals(PushBlocker.PERMISSION_DENIED, DeviceInfos.pushBlocker(inBuild = true, notificationsAllowed = false, asked = false, sdk = 31))
    }

    @Test fun `a pairing carries all of it, and the launch report all but the name`() {
        val info = DeviceInfo("Pixel", "Google", "Pixel 9", "16", "0.2.0")
        val registration = thisPhone("key", null, PushBlocker.NONE, info)
        assertEquals("Pixel", registration.name)
        assertEquals("16", registration.osVersion)
        assertEquals(PushBlocker.NONE, registration.pushBlocker)
        assertEquals("Given", thisPhone("key", " Given ", null, info).name)
        val report = thisPhoneReport(PushBlocker.PERMISSION_DENIED, info)
        assertEquals(null, report.name)
        assertEquals("Pixel 9", report.model)
        assertEquals(PushBlocker.PERMISSION_DENIED, report.pushBlocker)
    }
}
