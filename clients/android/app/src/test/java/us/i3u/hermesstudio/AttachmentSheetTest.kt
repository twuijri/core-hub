package us.i3u.hermesstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * The composer's "+" opens a bottom sheet, and it has to stay one.
 *
 * None of this is visible in a unit test run, so the three things that keep
 * breaking are checked here instead: the sheet still launches exactly the
 * pickers the old dropdown launched, it is written in tokens and start/end
 * terms, and iOS offers the same rows in the same order with the same icons.
 */
class AttachmentSheetTest {

    private val sheet = File("src/main/java/us/i3u/hermesstudio/ui/chat/AttachmentSheet.kt").readText()
    private val composer = File("src/main/java/us/i3u/hermesstudio/ui/chat/Composer.kt").readText()
    private val icons = File("src/main/java/us/i3u/hermesstudio/ui/theme/CoreHubIcons.kt").readText()
    private val iosSheet = File("../../ios/HermesStudio/Features/Chat/AttachmentSheet.swift")
    private val iosIcons = File("../../ios/HermesStudio/Theme/CoreHubIcons.swift")

    private fun strings(path: String): Map<String, String> {
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File(path))
        val nodes = document.getElementsByTagName("string")
        return (0 until nodes.length).associate { index ->
            val element = nodes.item(index) as Element
            element.getAttribute("name") to element.textContent
        }
    }

    /** Camera, gallery and file still open the same pickers as before. */
    @Test
    fun everyAttachmentActionKeepsItsPicker() {
        assertTrue("the sheet is presented from the composer", composer.contains("if (attachMenu) {"))
        assertTrue(composer.contains("onCamera = { askCamera.launch(Manifest.permission.CAMERA) }"))
        assertTrue(composer.contains("onGallery = { pickImage.launch(\"image/*\") }"))
        assertTrue(composer.contains("onFile = { pickFile.launch(\"*/*\") }"))
    }

    /** No menu hangs off the button any more; it is a real bottom sheet. */
    @Test
    fun thePlusOpensABottomSheetNotAnAnchoredMenu() {
        assertFalse(
            "the attachment dropdown is gone",
            composer.contains("DropdownMenu(expanded = attachMenu"),
        )
        assertTrue(sheet.contains("ModalBottomSheet("))
        assertTrue("the sheet draws its own drag handle", sheet.contains("dragHandle = { AttachmentSheetHandle() }"))
        assertTrue("safe area", sheet.contains(".navigationBarsPadding()"))
        assertTrue("keyboard", sheet.contains(".imePadding()"))
        assertTrue("an explicit way out", sheet.contains("R.string.action_close"))
        assertTrue("the scrim is the spec's 40 %", sheet.contains("CoreHubTokens.Metrics.scrimAlpha"))
    }

    /** Colours, radii and sizes come from the tokens, never from literals. */
    @Test
    fun theSheetIsBuiltFromTokens() {
        val hex = Regex("""Color\(0x[0-9A-Fa-f]{8}\)""")
        assertFalse("no hardcoded colour in the sheet", hex.containsMatchIn(sheet))
        listOf(
            "CoreHubTokens.Radius.composer",
            "CoreHubTokens.Metrics.sheetHandleWidth",
            "CoreHubTokens.Metrics.sheetRowMinHeight",
            "CoreHubTokens.Metrics.sheetIconTile",
            "CoreHubTokens.Metrics.sheetPadding",
        ).forEach { token -> assertTrue("missing $token", sheet.contains(token)) }
    }

    /** A row that points somewhere has to flip with the layout. */
    @Test
    fun theTrailingChevronMirrorsInArabic() {
        assertTrue(sheet.contains("CoreHubIcons.ChevronRight"))
        assertTrue("ChevronRight is auto-mirrored", icons.contains("""line("ChevronRight", "M9 6l6 6-6 6", mirror = true)"""))
    }

    /** Every label and caption is translated. */
    @Test
    fun everySheetStringExistsInBothLanguages() {
        val keys = listOf(
            "attach_sheet_title", "attach_sheet_subtitle",
            "attach_group_photos", "attach_group_documents",
            "sheet_camera", "sheet_gallery", "sheet_file",
            "attach_camera_caption", "attach_gallery_caption", "attach_file_caption",
            "action_close",
        )
        val english = strings("src/main/res/values/strings.xml")
        val arabic = strings("src/main/res/values-ar/strings.xml")
        keys.forEach { key ->
            assertTrue("missing English $key", english[key]?.isNotBlank() == true)
            assertTrue("missing Arabic $key", arabic[key]?.isNotBlank() == true)
            assertTrue("$key was never translated", english[key] != arabic[key])
        }
    }

    /** The two clients offer the same rows, in the same order. */
    @Test
    fun iosOffersTheSameRowsInTheSameOrder() {
        if (!iosSheet.isFile) return
        val swift = iosSheet.readText()
        val order = listOf("Take photo", "Photo library", "Files")
        assertEquals(
            "iOS rows are in the Android order",
            order,
            order.sortedBy { label -> swift.indexOf("label: \"$label\"") },
        )
        order.forEach { label -> assertTrue("iOS is missing the $label row", swift.contains("label: \"$label\"")) }
        assertTrue(swift.contains("icon: .camera"))
        assertTrue(swift.contains("icon: .image"))
        assertTrue(swift.contains("icon: .paperclip"))
    }

    /** Both clients draw the same three icons from the same path data. */
    @Test
    fun bothClientsUseTheSameAttachmentIconPaths() {
        if (!iosIcons.isFile) return
        val swift = iosIcons.readText()
        listOf(
            "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z",
            "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
            "M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21",
            "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48",
        ).forEach { path ->
            assertTrue("Android is missing an attachment icon path", icons.contains(path))
            assertTrue("iOS is missing the same path", swift.contains(path))
        }
    }
}
