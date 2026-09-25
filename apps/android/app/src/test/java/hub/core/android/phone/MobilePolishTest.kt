package hub.core.android.phone

import hub.core.android.MemoryPrefs
import hub.core.android.R
import hub.core.android.chat.AttachmentBackend
import hub.core.android.chat.AttachmentRules
import hub.core.android.chat.AttachmentTray
import hub.core.android.chat.AttachmentUploader
import hub.core.android.chat.mimeOf
import hub.core.android.chat.Outgoing
import hub.core.android.data.HubError
import hub.core.android.repoRoot
import hub.core.client.model.Attachment
import hub.core.client.model.ContentBlock
import hub.core.client.model.Upload
import java.io.File
import java.time.OffsetDateTime
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Files in the composer (docs/changes/2026-09-26-twuijri-mobile-polish.md §٤). */
@OptIn(ExperimentalCoroutinesApi::class)
class AttachmentsTest {
    private fun attachment(id: String, kind: Attachment.Kind, name: String) = Attachment(
        id = id, profile = "work", ownerId = "01J8QK3ZR2W7M5N4P6T8V9X0HM",
        createdAt = OffsetDateTime.parse("2026-09-21T10:14:50Z"), updatedAt = OffsetDateTime.parse("2026-09-21T10:14:50Z"),
        name = name, mime = if (kind == Attachment.Kind.IMAGE) "image/jpeg" else "application/pdf", sizeBytes = 1234,
        kind = kind, url = "/api/v1/attachments/$id/content", sha256 = "0".repeat(64),
    )

    private fun file(name: String, bytes: Int = 5): File =
        File(kotlin.io.path.createTempDirectory("outgoing").toFile(), name).apply { writeBytes(ByteArray(bytes)) }

    @Test
    fun theMessageCarriesTextThenOneBlockPerFile() {
        val photo = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AA", Attachment.Kind.IMAGE, "photo.jpg")
        val pdf = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AB", Attachment.Kind.FILE, "plan.pdf")
        val blocks = Outgoing("  look  ", listOf(photo, pdf)).blocks()
        assertEquals(listOf(ContentBlock.Type.TEXT, ContentBlock.Type.IMAGE, ContentBlock.Type.FILE), blocks.map { it.type })
        assertEquals("look", blocks[0].text)
        assertEquals(photo.id, blocks[1].attachmentId)
        assertEquals("plan.pdf", blocks[2].name)
        // Files alone are a message; nothing at all is not.
        assertFalse(Outgoing(" ", listOf(pdf)).isEmpty)
        assertEquals(1, Outgoing(" ", listOf(pdf)).blocks().size)
        assertTrue(Outgoing(" \n").isEmpty)
    }

    @Test
    fun photosShrinkToTheLongerSideLimitAndNeverGrow() {
        assertEquals(2048 to 1536, AttachmentRules.fitted(4032, 3024))
        assertEquals(1536 to 2048, AttachmentRules.fitted(3024, 4032))
        assertEquals(800 to 600, AttachmentRules.fitted(800, 600))
        assertEquals("50 MB", AttachmentRules.sizeText(AttachmentRules.MAX_BYTES))
        assertEquals("25 MB", AttachmentRules.sizeText(AttachmentRules.MAX_ONE_SHOT_BYTES))
    }

    @Test
    fun theTrayUploadsAtOnceAndSendsOnlyWhatFinished() = runTest {
        val uploaded = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AC", Attachment.Kind.FILE, "notes.txt")
        val gate = CompletableDeferred<Unit>()
        val names = mutableListOf<String>()
        val discarded = mutableListOf<String>()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val tray = AttachmentTray(
            scope,
            upload = { f -> names += f.name; gate.await(); uploaded },
            discard = { discarded += it.id },
        )
        val picked = file("notes.txt")
        tray.add(picked, isImage = false)
        scope.advanceUntilIdle()
        assertTrue(tray.uploading)
        assertTrue("nothing is sent while it is uploading", tray.attachments.isEmpty())

        gate.complete(Unit)
        scope.advanceUntilIdle()
        assertEquals(listOf("notes.txt"), names)
        assertEquals(listOf(uploaded), tray.attachments)
        assertFalse("the local copy is gone once it is on the hub", picked.exists())

        // The chip's ×: gone from the message, deleted on the hub.
        tray.remove(tray.items.value.single().id)
        scope.advanceUntilIdle()
        assertEquals(listOf(uploaded.id), discarded)
        assertTrue(tray.items.value.isEmpty())
    }

    @Test
    fun aFileOverTheHubsLimitIsRefusedAndTheHubs413ReadsTheSame() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        var uploads = 0
        val tray = AttachmentTray(scope, upload = { uploads++; throw HubError(413, "payload_too_large", "Too large") }, discard = {})
        val big = File(kotlin.io.path.createTempDirectory("outgoing").toFile(), "big.bin").apply {
            java.io.RandomAccessFile(this, "rw").use { it.setLength(AttachmentRules.MAX_BYTES + 1) }
        }
        tray.add(big, isImage = false)
        scope.advanceUntilIdle()
        assertEquals(0, uploads)
        assertEquals(AttachmentTray.State.Failed(null, tooLarge = true), tray.items.value.single().state)

        tray.add(file("small.pdf"), isImage = false)
        scope.advanceUntilIdle()
        val failed = tray.items.value.last().state as AttachmentTray.State.Failed
        assertTrue(failed.tooLarge)
        assertEquals(413, failed.error?.status)
        assertFalse(tray.uploading)
    }
}

/** Original quality and the hub's own limit (docs/changes/2026-09-26-twuijri-mobile-polish-2.md). */
@OptIn(ExperimentalCoroutinesApi::class)
class PhotoQualityTest {
    private fun attachment(id: String, kind: Attachment.Kind = Attachment.Kind.IMAGE) = Attachment(
        id = id, profile = "work", ownerId = "01J8QK3ZR2W7M5N4P6T8V9X0HM",
        createdAt = OffsetDateTime.parse("2026-09-21T10:14:50Z"), updatedAt = OffsetDateTime.parse("2026-09-21T10:14:50Z"),
        name = "photo.heic", mime = "image/heic", sizeBytes = 4_000_000, kind = kind,
        url = "/api/v1/attachments/$id/content", sha256 = "0".repeat(64),
    )

    @Test
    fun anOriginalPhotoGoesAsAFileAndACompressedOneAsAnImage() {
        val original = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AA")
        val compressed = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AB")
        val blocks = Outgoing("", listOf(original, compressed), setOf(original.id)).blocks()
        assertEquals(listOf(ContentBlock.Type.FILE, ContentBlock.Type.IMAGE), blocks.map { it.type })
        assertEquals("image/heic", blocks[0].mime)
    }

    @Test
    fun theTrayMarksOriginalPhotosAndSendsTheirBytesUntouched() = runTest {
        val uploaded = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AC")
        var sent: ByteArray? = null
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val tray = AttachmentTray(scope, upload = { f -> sent = f.readBytes(); uploaded }, discard = {})
        val bytes = ByteArray(4096) { (it % 251).toByte() }
        val file = File(kotlin.io.path.createTempDirectory("outgoing").toFile(), "photo.heic").apply { writeBytes(bytes) }
        tray.add(file, isImage = true, asFile = true)
        scope.advanceUntilIdle()
        assertTrue(bytes.contentEquals(sent))
        assertEquals(setOf(uploaded.id), tray.asFiles)
        assertEquals(setOf(uploaded.id), tray.message("hi").asFiles)
    }

    @Test
    fun compressedIsTheDefaultAndTheChoiceIsRemembered() {
        val prefs = MemoryPrefs()
        assertFalse(DeviceSettings(prefs).choices.value.photoOriginal)
        DeviceSettings(prefs).update { it.copy(photoOriginal = true) }
        assertTrue(DeviceSettings(prefs).choices.value.photoOriginal)
    }

    @Test
    fun thePhoneKeepsTheContractsAttachmentLimit() {
        // UploadStart.size_bytes.maximum in openapi.yaml: the contract has no call that reports it.
        val yaml = File(repoRoot, "packages/contracts/openapi.yaml").readText()
        val section = yaml.substringAfter("\n    UploadStart:\n").take(600)
        val maximum = Regex("maximum: (\\d+)").find(section)!!.groupValues[1].toLong()
        assertEquals(maximum, AttachmentRules.MAX_BYTES)
        assertTrue(AttachmentRules.MAX_BYTES > AttachmentRules.MAX_ONE_SHOT_BYTES)
        assertEquals(52_428_800L, HubError.maxBytesOf("""{"error":"x","code":"payload_too_large","details":{"max_bytes":52428800}}"""))
    }

    @Test
    fun filesOverTheOneRequestLimitGoInChunks() = runTest {
        val calls = mutableListOf<String>()
        var received = 0L
        var failChunks = false
        val chunkBytes = 10L * 1024 * 1024
        val backend = object : AttachmentBackend {
            fun upload(next: Long, size: Long) = Upload(
                id = "01J8QK3ZR2W7M5N4P6T8V9X0WP", name = "f", mime = "m", sizeBytes = size, chunkBytes = chunkBytes,
                nextOffset = next.toInt(), expiresAt = OffsetDateTime.parse("2026-09-21T10:20:00Z"),
            )
            var size = 0L
            override suspend fun oneShot(file: File) = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AD", Attachment.Kind.FILE).also { calls += "oneShot" }
            override suspend fun start(name: String, mime: String, sizeBytes: Long): Upload {
                calls += "start:$mime"; size = sizeBytes; received = 0; return upload(0, sizeBytes)
            }
            override suspend fun chunk(uploadId: String, offset: Long, body: File): Upload {
                calls += "chunk@$offset"
                if (failChunks) throw java.io.IOException("dropped")
                assertTrue(body.length() <= chunkBytes)
                received += body.length()
                return upload(offset + body.length(), size)
            }
            override suspend fun complete(uploadId: String) = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AE", Attachment.Kind.FILE).also { calls += "complete" }
            override suspend fun abort(uploadId: String) { calls += "abort" }
        }
        val dir = kotlin.io.path.createTempDirectory("outgoing").toFile()
        AttachmentUploader(backend).upload(File(dir, "small.pdf").apply { writeBytes(ByteArray(1024)) }, "application/pdf")
        assertEquals(listOf("oneShot"), calls)

        val size = AttachmentRules.MAX_ONE_SHOT_BYTES + 3
        val big = File(dir, "big.heic").apply { java.io.RandomAccessFile(this, "rw").use { it.setLength(size) } }
        calls.clear()
        AttachmentUploader(backend).upload(big, mimeOf(big))
        assertEquals(listOf("start:image/heic", "chunk@0", "chunk@10485760", "chunk@20971520", "complete"), calls)
        assertEquals(size, received)

        calls.clear()
        failChunks = true
        val failed = runCatching { AttachmentUploader(backend).upload(big, mimeOf(big)) }
        assertTrue(failed.isFailure)
        assertEquals("the open upload is let go", "abort", calls.last())
    }
}

/** Where the voice comes from (§٥). */
class VoiceSourceTest {
    @Test
    fun theHubSpeaksOnlyWhenChosenAndReady() {
        assertEquals(VoiceRoute.HUB, VoiceRoute.choose(VoiceSource.HUB, true))
        assertEquals(VoiceRoute.PHONE, VoiceRoute.choose(VoiceSource.HUB, false))
        assertEquals(VoiceRoute.PHONE, VoiceRoute.choose(VoiceSource.HUB, null))
        assertEquals(VoiceRoute.PHONE, VoiceRoute.choose(VoiceSource.PHONE, true))
    }

    @Test
    fun thisPhoneIsTheDefaultAndOnlyAPickPinsTheVoice() {
        // Owner, 2026-09-26: «خل الأساسي حق الجوال ويقدر يغير المستخدم».
        val prefs = MemoryPrefs()
        // 1.1.x wrote the old key with every change, chosen or not: it is not read any more.
        prefs.values["voice_source"] = "HUB"
        assertEquals(VoiceSource.PHONE, DeviceSettings(prefs).choices.value.voiceSource)
        // Changing another choice does not pin the voice.
        DeviceSettings(prefs).update { it.copy(spokenReplies = true) }
        assertFalse(prefs.values.containsKey("voice_source_chosen"))
        assertEquals(VoiceSource.PHONE, DeviceSettings(prefs).choices.value.voiceSource)
        DeviceSettings(prefs).update { it.copy(voiceSource = VoiceSource.HUB) }
        assertEquals(VoiceSource.HUB, DeviceSettings(prefs).choices.value.voiceSource)
        DeviceSettings(prefs).update { it.copy(spokenReplies = false) }
        assertEquals("a pick stays picked", VoiceSource.HUB, DeviceSettings(prefs).choices.value.voiceSource)
    }

    @Test
    fun longRepliesAreSpokenInPartsTheHubTakes() {
        val text = "This is one sentence of a long reply. ".repeat(120)
        val parts = VoiceText.chunks(text)
        assertTrue(parts.size > 1)
        assertTrue(parts.all { it.length <= VoiceText.HUB_LIMIT })
        assertTrue("cut at a sentence", parts.all { it.endsWith(".") })
        assertEquals(text.trim(), parts.joinToString(" "))
        assertEquals(listOf("short"), VoiceText.chunks("short"))
        assertEquals(emptyList<String>(), VoiceText.chunks("  "))
    }

    @Test
    fun aSilentTakeIsNamedByTheHubsReason() {
        val body = JSONObject(mapOf("error" to "No speech", "code" to "validation_failed", "details" to mapOf("reason" to "no_speech"))).toString()
        assertEquals("no_speech", HubError.reasonOf(body))
        assertNull(HubError.reasonOf("""{"error":"x","details":{"reason":{"odd":1}}}"""))
        assertNull(HubError.reasonOf("not json"))
    }
}

/** Notification permission and push, in plain words (§٧). */
class NotificationStatusTest {
    @Test
    fun theAppAsksOnceALaunchOnlyWhileNotGrantedAndNeverAfterANo() {
        assertTrue(NotificationAsk.shouldAsk(sdk = 34, granted = false, deniedBefore = false, askedThisLaunch = false))
        assertFalse("once a launch", NotificationAsk.shouldAsk(34, granted = false, deniedBefore = false, askedThisLaunch = true))
        assertFalse("never after a no", NotificationAsk.shouldAsk(34, granted = false, deniedBefore = true, askedThisLaunch = false))
        assertFalse("already allowed", NotificationAsk.shouldAsk(34, granted = true, deniedBefore = false, askedThisLaunch = false))
        assertFalse("before Android 13 there is no prompt", NotificationAsk.shouldAsk(32, granted = false, deniedBefore = false, askedThisLaunch = false))
    }

    @Test
    fun eachStateHasItsPlainWords() {
        assertEquals(R.string.push_waiting, PushStatus.label(PushState.IDLE, allowed = false, denied = false))
        assertEquals(R.string.push_off, PushStatus.label(PushState.ACTIVE, allowed = false, denied = true))
        assertEquals(R.string.push_on, PushStatus.label(PushState.ACTIVE, allowed = true, denied = false))
        assertEquals(R.string.push_no_sender, PushStatus.label(PushState.NO_SENDER, allowed = true, denied = false))
        assertEquals(R.string.push_failed, PushStatus.label(PushState.FAILED, allowed = true, denied = false))
        assertEquals(R.string.push_setting_up, PushStatus.label(PushState.IDLE, allowed = true, denied = false))
        val labels = PushState.entries.map { PushStatus.label(it, allowed = true, denied = false) }
        assertEquals(PushState.entries.size, labels.toSet().size)
    }

    @Test
    fun foregroundRetriesUntilPushWorks() {
        assertTrue(PushStatus.retriesOnForeground(PushState.NO_SENDER))
        assertTrue(PushStatus.retriesOnForeground(PushState.FAILED))
        assertTrue(PushStatus.retriesOnForeground(PushState.IDLE))
        assertFalse(PushStatus.retriesOnForeground(PushState.ACTIVE))
        assertFalse(PushStatus.retriesOnForeground(PushState.NOT_IN_BUILD))
    }
}

/** Lucide icons (§٦): the committed drawables are exactly the list the script writes. */
class LucideDrawablesTest {
    @Test
    fun everyListedIconIsADrawableAndNothingElse() {
        val listed = JSONObject(File(repoRoot, "scripts/icons/lucide-mobile.json").readText()).getJSONArray("icons")
            .let { a -> (0 until a.length()).map { "lucide_" + a.getString(it).replace('-', '_') + ".xml" } }.toSet()
        val drawables = File(repoRoot, "apps/android/app/src/main/res/drawable").list()!!.filter { it.startsWith("lucide_") }.toSet()
        assertEquals(listed, drawables)
        drawables.forEach { name ->
            val xml = File(repoRoot, "apps/android/app/src/main/res/drawable/$name").readText()
            assertTrue("$name names its source", xml.contains("lucide-static"))
            assertTrue("$name is stroked like Lucide", xml.contains("android:strokeLineCap=\"round\""))
        }
    }
}
