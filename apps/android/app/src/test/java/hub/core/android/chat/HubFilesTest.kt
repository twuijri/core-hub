package hub.core.android.chat

import hub.core.android.data.AuthInterceptor
import hub.core.android.data.HubError
import hub.core.android.data.TokenRefresher
import hub.core.android.memoryStore
import hub.core.android.storedSession
import hub.core.client.api.MetaApi
import hub.core.client.api.SessionsApi
import hub.core.client.model.ContentBlock
import hub.core.client.model.SessionFile
import hub.core.client.model.SessionFilePreview
import hub.core.client.model.SessionFileSource
import hub.core.client.model.SessionsCreateFileStreamRequest
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * Opening a conversation's files on Android (docs/changes/2026-09-26-twuijri-mobile-open-files.md):
 * which way each kind opens, which file a reply's link names, and the download against a stand-in
 * hub — through the generated client, with the bearer header, progress, the cache and cancel.
 * No hub path is typed here: every one comes from the generated client.
 */
class HubFilesTest {
    private val server = MockWebServer()
    private lateinit var root: File
    private val id = "01J8QK3ZR2W7M5N4P6T8V9X0AA"

    /** Where the generated client asks for an attachment's bytes, as the hub serves them. */
    private fun contentPath(attachmentId: String) =
        MetaApi.defaultBasePath + SessionsApi("").sessionsDownloadAttachmentRequestConfig("default", attachmentId, null).path

    @Before fun start() {
        server.start()
        root = Files.createTempDirectory("files").toFile()
    }

    @After fun stop() {
        server.shutdown()
        root.deleteRecursively()
    }

    private val hub get() = server.url("/").toString().trimEnd('/')

    /** The app's own authed client: the bearer goes in by AuthInterceptor, as on the phone. */
    private fun authed(): OkHttpClient {
        val store = memoryStore()
        store.save(storedSession(hub = hub, token = "tok-1"))
        val plain = OkHttpClient()
        return plain.newBuilder().addInterceptor(AuthInterceptor(store, TokenRefresher(store, plain) {}, { "ar" }) {}).build()
    }

    private fun picture(bytes: Int = 4096): MockResponse = MockResponse()
        .setHeader("Content-Type", "image/png")
        .setHeader("Content-Disposition", "attachment; filename=\"retouch.png\"; filename*=UTF-8''retouch.png")
        .setBody(Buffer().write(ByteArray(bytes) { (it % 251).toByte() }))

    // ---------------------------------------------------------------- how each kind opens

    @Test fun `pictures draw in the app, documents open in the viewer, sound and video play, the rest is shared`() {
        assertEquals(FileOpen.PICTURE, FileKinds.openAs("photo-20260926-175004.jpg", "image/jpeg"))
        assertEquals(FileOpen.PICTURE, FileKinds.openAs("retouch.png", "application/octet-stream"))
        assertEquals(FileOpen.VIEWER, FileKinds.openAs("plan.svg", "image/svg+xml"))
        assertEquals(FileOpen.VIEWER, FileKinds.openAs("report.pdf", "application/pdf"))
        assertEquals(FileOpen.VIEWER, FileKinds.openAs("notes.txt", "text/plain; charset=utf-8"))
        assertEquals(FileOpen.VIEWER, FileKinds.openAs("budget.xlsx", null))
        assertEquals(FileOpen.MEDIA, FileKinds.openAs("voice.m4a", "audio/mp4"))
        assertEquals(FileOpen.MEDIA, FileKinds.openAs("render.mp4", null))
        assertEquals(FileOpen.SHARE, FileKinds.openAs("backup.zip", "application/zip"))
        assertEquals(FileOpen.SHARE, FileKinds.openAs("blob", null))
    }

    @Test fun `a picture sent as a file is drawn too, an image block the phone cannot draw is a row`() {
        assertTrue(ChatAttachment(ContentBlock.Type.FILE, "photo.jpg", null, id, "image/jpeg").isImage)
        assertTrue(ChatAttachment(ContentBlock.Type.IMAGE, "scan", null, id, null).isImage)
        assertFalse(ChatAttachment(ContentBlock.Type.IMAGE, "plan.svg", null, id, "image/svg+xml").isImage)
        assertFalse(ChatAttachment(ContentBlock.Type.FILE, "report.pdf", null, id, "application/pdf").isImage)
    }

    // ---------------------------------------------------------------- links in a reply

    private val reply = listOf(
        ChatAttachment(ContentBlock.Type.IMAGE, "retouch-this-exact-photo-20260926-175416-1.png", contentPath(id), id, "image/png", 4096),
        ChatAttachment(ContentBlock.Type.FILE, "تقرير.pdf", contentPath("01J8QK3ZR2W7M5N4P6T8V9X0AB"), "01J8QK3ZR2W7M5N4P6T8V9X0AB", "application/pdf"),
    )

    @Test fun `a link to an attachment's address, relative or on the hub, opens that attachment`() {
        val relative = FileLinks.resolve(contentPath(id), hub, reply)
        assertEquals(HubFile.Attachment(id, reply[0].name!!, "image/png", 4096), relative)
        assertEquals(relative, FileLinks.resolve(hub + contentPath(id), hub, reply))
        // The same address on another site is an ordinary link.
        assertNull(FileLinks.resolve("https://elsewhere.example" + contentPath(id), hub, reply))
    }

    @Test fun `a link by name opens the reply's own file, encoded names included`() {
        assertEquals(id, (FileLinks.resolve("retouch-this-exact-photo-20260926-175416-1.png", hub, reply) as HubFile.Attachment).id)
        assertEquals(id, (FileLinks.resolve("./out/retouch-this-exact-photo-20260926-175416-1.png", hub, reply) as HubFile.Attachment).id)
        assertEquals(
            "01J8QK3ZR2W7M5N4P6T8V9X0AB",
            (FileLinks.resolve("%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf", hub, reply) as HubFile.Attachment).id,
        )
        assertEquals(id, (FileLinks.resolve("sandbox:/mnt/data/retouch-this-exact-photo-20260926-175416-1.png", hub, reply) as HubFile.Attachment).id)
    }

    @Test fun `a link to the working folder opens that file, other links stay links`() {
        val files = listOf(
            SessionFile(
                key = "path:out/report.html", name = "report.html", mime = "text/html", preview = SessionFilePreview.HTML,
                sizeBytes = 2048, previewMaxBytes = 5_242_880, sources = listOf(SessionFileSource.TOOL), toolCallIds = emptyList(), path = "out/report.html",
            ),
        )
        val file = FileLinks.resolve("./out/report.html", hub, reply, files, "S1")
        assertTrue(file is HubFile.Working)
        assertEquals("out/report.html", (file as HubFile.Working).path)
        assertEquals("S1", file.sessionId)
        assertEquals(file, FileLinks.resolve("/data/workspaces/default/S1/out/report.html", hub, reply, files, "S1"))
        assertNull(FileLinks.resolve("https://example.com/report.html", hub, reply, files, "S1"))
        assertNull(FileLinks.resolve("#section", hub, reply, files, "S1"))
        assertNull(FileLinks.resolve("mailto:someone@example.com", hub, reply, files, "S1"))
        assertNull(FileLinks.resolve("unknown.html", hub, reply, files, "S1"))
    }

    // ---------------------------------------------------------------- the download

    @Test fun `an attachment is fetched with the bearer header into the cache under its name, once`() = runBlocking {
        server.enqueue(picture())
        val fetcher = HubFileFetcher(authed(), root)
        val seen = mutableListOf<Progress>()
        val file = HubFile.Attachment(id, "retouch.png", "image/png", 4096)
        val local = fetcher.fetch(hub, "work", file) { seen += it }
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals(contentPath(id), request.path)
        assertEquals("Bearer tok-1", request.getHeader("Authorization"))
        assertEquals("work", request.getHeader("X-Hub-Profile"))
        assertEquals(File(File(root, id), "retouch.png"), local)
        assertEquals(4096L, local.length())
        assertEquals(Progress(4096, 4096), seen.last())
        assertFalse("nothing half-written is left beside it", File(local.parentFile, "retouch.png.part").exists())
        // Kept: a second open reads the phone's copy.
        assertEquals(local, fetcher.fetch(hub, "work", file))
        assertEquals(1, server.requestCount)
    }

    @Test fun `a file of the working folder is fetched for download from the conversation`() = runBlocking {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/html").setBody("<p>hi</p>"))
        val fetcher = HubFileFetcher(authed(), root)
        val local = fetcher.fetch(hub, "default", HubFile.Working("S1", "out/report.html", "report.html", "text/html", 9))
        val request = server.takeRequest()
        val expected = SessionsApi("").sessionsReadFileRequestConfig("default", "S1", "out/report.html", true, null)
        assertEquals(MetaApi.defaultBasePath + expected.path, request.requestUrl!!.encodedPath)
        assertEquals("out/report.html", request.requestUrl!!.queryParameter("path"))
        assertEquals("true", request.requestUrl!!.queryParameter("download"))
        assertEquals("Bearer tok-1", request.getHeader("Authorization"))
        assertEquals("<p>hi</p>", local.readText())
    }

    @Test fun `a refusal is the hub's error and leaves nothing in the cache`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Not found","code":"not_found"}"""))
        val fetcher = HubFileFetcher(authed(), root)
        val file = HubFile.Attachment(id, "retouch.png", "image/png", 4096)
        try {
            fetcher.fetch(hub, "default", file)
            fail("a 404 is not a file")
        } catch (e: HubError) {
            assertEquals(404, e.status)
            assertEquals("not_found", e.code)
        }
        assertNull(fetcher.cached(file))
    }

    @Test fun `cancelling a download stops it and keeps no half file`() = runBlocking {
        // 256 KB sent 8 KB every 200 ms: long enough to cancel in the middle.
        server.enqueue(picture(256 * 1024).throttleBody(8 * 1024, 200, TimeUnit.MILLISECONDS))
        val fetcher = HubFileFetcher(authed(), root)
        val file = HubFile.Attachment(id, "big.png", "image/png", 256L * 1024)
        val started = CompletableDeferred<Unit>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val job = scope.async { fetcher.fetch(hub, "default", file) { if (it.read > 0) started.complete(Unit) } }
        withTimeout(10_000) { started.await() }
        job.cancelAndJoin()
        assertTrue(job.isCancelled)
        try {
            job.await()
            fail("cancelled")
        } catch (_: CancellationException) {
        }
        assertNull(fetcher.cached(file))
        assertFalse(File(File(root, id), "big.png").exists())
        assertFalse(File(File(root, id), "big.png.part").exists())
    }

    @Test fun `downloads share one fetch per file and say when it is ready`() = runBlocking {
        server.enqueue(picture())
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val downloads = FileDownloads(HubFileFetcher(authed(), root), { hub }, scope)
        val file = HubFile.Attachment(id, "retouch.png", "image/png", 4096)
        downloads.start(file, "default")
        downloads.start(file, "default")
        val ready = withTimeout(10_000) { downloads.states.first { it[file.cacheKey] is FileDownloads.State.Ready } }
        assertEquals(4096L, (ready[file.cacheKey] as FileDownloads.State.Ready).file.length())
        assertEquals(1, server.requestCount)
        assertTrue(downloads.state(file) is FileDownloads.State.Ready)
    }

    @Test fun `sound and video play from the contract's ticket, resolved against the hub`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(201).setHeader("Content-Type", "application/json")
                .setBody("""{"url":"/streams/7c1b0e5f","expires_at":"2026-09-26T11:14:50Z"}"""),
        )
        server.enqueue(
            MockResponse().setResponseCode(201).setHeader("Content-Type", "application/json")
                .setBody("""{"url":"/streams/9d2c4e6f","expires_at":"2026-09-26T11:14:50Z"}"""),
        )
        val fetcher = HubFileFetcher(authed(), root)
        val address = fetcher.streamAddress(hub, "default", HubFile.Attachment(id, "voice.m4a", "audio/mp4"))
        assertEquals(server.url("/streams/7c1b0e5f").toString(), address)
        val ticket = server.takeRequest()
        assertEquals("POST", ticket.method)
        assertEquals(MetaApi.defaultBasePath + SessionsApi("").sessionsCreateAttachmentStreamRequestConfig("default", id).path, ticket.path)
        assertEquals("Bearer tok-1", ticket.getHeader("Authorization"))

        val video = fetcher.streamAddress(hub, "default", HubFile.Working("S1", "renders/final.mp4", "final.mp4", "video/mp4"))
        assertEquals(server.url("/streams/9d2c4e6f").toString(), video)
        val second = server.takeRequest()
        val expected = SessionsApi("").sessionsCreateFileStreamRequestConfig("default", "S1", SessionsCreateFileStreamRequest(path = "renders/final.mp4"))
        assertEquals(MetaApi.defaultBasePath + expected.path, second.path)
        assertTrue(second.body.readUtf8().contains("renders/final.mp4"))
        assertNotNull(second.getHeader("Authorization"))
    }
}
