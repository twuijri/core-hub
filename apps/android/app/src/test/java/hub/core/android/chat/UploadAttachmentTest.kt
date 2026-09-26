package hub.core.android.chat

import hub.core.android.data.HubApis
import java.io.File
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * A picture picked in the composer reaches the hub as one multipart request. The generated
 * client used to give the file part its own Content-Type header, which OkHttp refuses
 * ("Unexpected header: Content-Type"), so every upload from the phone failed before leaving it.
 */
class UploadAttachmentTest {
    private val server = MockWebServer()

    @Before fun start() = server.start()

    @After fun stop() = server.shutdown()

    @Test fun uploadsAPictureAsMultipart() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(201).setHeader("Content-Type", "application/json").setBody(
                """
                {"id":"01J8QK3ZR2W7M5N4P6T8V9X0HM","profile":"default","owner_id":"01J8QK3ZR2W7M5N4P6T8V9X0HN",
                 "created_at":"2026-09-26T16:29:45Z","updated_at":"2026-09-26T16:29:45Z",
                 "name":"photo-20260926-162945.jpg","mime":"image/jpeg","size_bytes":4,"kind":"image",
                 "url":"https://hub.example/picture","purpose":"message",
                 "sha256":"0000000000000000000000000000000000000000000000000000000000000000"}
                """.trimIndent(),
            ),
        )
        val file = File.createTempFile("photo-20260926-162945", ".jpg").apply {
            writeBytes(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xD9.toByte()))
            deleteOnExit()
        }
        val backend = HubAttachmentBackend(HubApis(server.url("/").toString(), OkHttpClient()), "default")

        val attachment = AttachmentUploader(backend).upload(file, "image/jpeg")

        assertEquals("01J8QK3ZR2W7M5N4P6T8V9X0HM", attachment.id)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertTrue(request.getHeader("Content-Type").orEmpty().startsWith("multipart/form-data"))
        assertEquals("default", request.getHeader("X-Hub-Profile"))
        val body = request.body.readUtf8()
        assertTrue(body.contains("name=\"file\"; filename=\"${file.name}\""))
        assertTrue(body.contains("name=\"purpose\""))
    }
}
