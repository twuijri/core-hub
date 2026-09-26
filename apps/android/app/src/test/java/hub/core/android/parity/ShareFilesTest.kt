package hub.core.android.parity

import android.content.Intent
import android.net.Uri
import hub.core.android.phone.Share
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Share to Core Hub with pictures and files (B14): which streams a share carries, and what a picture is. */
@RunWith(RobolectricTestRunner::class)
class ShareFilesTest {
    private val a = Uri.parse("content://media/external/images/1")
    private val b = Uri.parse("content://downloads/2")

    @Test fun `one stream for send, every stream for send multiple, none for text`() {
        assertEquals(listOf(a), Share.streamsOf(Intent.ACTION_SEND, a, null))
        assertEquals(listOf(a, b), Share.streamsOf(Intent.ACTION_SEND_MULTIPLE, null, listOf(a, b, a)))
        assertTrue(Share.streamsOf(Intent.ACTION_SEND, null, null).isEmpty())
        assertTrue(Share.streamsOf(Intent.ACTION_VIEW, a, listOf(b)).isEmpty())
    }

    @Test fun `the intent's streams are read from its extras`() {
        val many = Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(a, b))
        assertEquals(listOf(a, b), Share.streamsOf(many))
        val one = Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, b).setType("application/pdf")
        assertEquals(listOf(b), Share.streamsOf(one))
    }

    @Test fun `a picture is known by its type, or by its name when there is no type`() {
        assertTrue(Share.isImage("image/heic", null))
        assertTrue(Share.isImage(null, "IMG_1.JPG"))
        assertFalse(Share.isImage("application/pdf", "scan.jpg"))
        assertFalse(Share.isImage(null, "notes.txt"))
    }
}
