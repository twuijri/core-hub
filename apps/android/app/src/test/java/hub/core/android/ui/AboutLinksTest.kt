package hub.core.android.ui

import hub.core.android.R
import hub.core.android.generated.Product
import hub.core.android.repoRoot
import hub.core.android.ui.screens.AboutVersionRow
import hub.core.android.ui.screens.aboutVersionRows
import hub.core.android.ui.screens.shownAddress
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * About and the drawer (owner, 2026-10-27): this app's version first, the connected hub's only
 * when there is one, and where Core Hub lives — the download page and the repository, from
 * packages/contracts' `PRODUCT_LINKS`.
 */
class AboutLinksTest {
    @Test fun `the links are the product's own`() {
        assertEquals("https://github.com/twuijri/core-hub", Product.REPOSITORY_URL)
        assertEquals("https://twuijri.github.io/core-hub/", Product.DOWNLOAD_PAGE_URL)
    }

    @Test fun `About writes an address without the scheme or the last slash`() {
        assertEquals("twuijri.github.io/core-hub", shownAddress(Product.DOWNLOAD_PAGE_URL))
        assertEquals("github.com/twuijri/core-hub", shownAddress(Product.REPOSITORY_URL))
    }

    @Test fun `About starts with this app, then the connected hub only when there is one`() {
        assertEquals(
            listOf(
                AboutVersionRow("app_version", R.string.about_app_version, "1.1.10"),
                AboutVersionRow("connected_hub", R.string.about_connected_hub, "1.1.8"),
            ),
            aboutVersionRows("1.1.10", "1.1.8"),
        )
        assertEquals(listOf("app_version"), aboutVersionRows("1.1.10", null).map { it.key })
    }

    @Test fun `every language names the links and the versions`() {
        val keys = listOf(
            "about_links", "about_download_page", "about_download_page_note", "about_repository",
            "about_repository_note", "shell_repository", "about_app_version", "about_connected_hub",
        )
        for (lang in listOf("en", "ar")) {
            val strings = JSONObject(File(repoRoot, "apps/android/i18n/$lang.json").readText())
            keys.forEach { assertTrue("$lang $it", strings.optString(it).isNotBlank()) }
        }
    }

    @Test fun `the drawer's GitHub mark is GitHub's own`() {
        val drawable = File(repoRoot, "apps/android/app/src/main/res/drawable/github_mark.xml").readText()
        assertTrue(drawable.contains("android:viewportWidth=\"16\""))
    }
}
