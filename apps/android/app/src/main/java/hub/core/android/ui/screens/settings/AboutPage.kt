package hub.core.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.BuildConfig
import hub.core.android.R
import hub.core.android.generated.FontTokens
import hub.core.android.generated.Product
import hub.core.android.graph
import hub.core.android.ui.components.Load
import hub.core.android.ui.components.LoadView
import hub.core.android.ui.components.rememberLoad
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.theme.LocalTokens

@Composable
private fun AboutPage() {
    val context = LocalContext.current
    val meta = rememberLoad { context.graph.apis(context.graph.store.current!!).meta.metaGet() }
    LazyColumn(contentPadding = settingsPagePadding, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                hub.core.android.ui.components.BrandMark(48)
                Text(stringResource(R.string.app_name), fontSize = FontTokens.sizeXl.sp, fontWeight = FontWeight.SemiBold)
                Text(stringResource(R.string.about_app, BuildConfig.VERSION_NAME), fontSize = FontTokens.sizeSm.sp, color = LocalTokens.current.textMuted)
            }
        }
        // This app first, then the hub it is connected to, only when it is (owner, 2026-10-27), as on
        // the web and iOS.
        item {
            val hub = (meta.state as? Load.Ready)?.value?.serverVersion
            GroupedList {
                aboutVersionRows(BuildConfig.VERSION_NAME, hub).forEach { row ->
                    Item(stringResource(row.label), value = row.value, modifier = Modifier.testTag("about.${row.key}"))
                }
            }
        }
        item {
            LoadView(meta) { m ->
                GroupedList {
                    Item(m.name, subtitle = stringResource(R.string.about_hub, m.serverVersion, m.contractVersion), icon = Lucide.Server)
                    Item(stringResource(R.string.about_address), subtitle = context.graph.store.current?.hub, icon = Lucide.Link)
                }
            }
        }
        // Where Core Hub lives (owner, 2026-10-27), as on the web and iOS: the download page and the
        // repository, for somebody who forgot.
        item {
            val uri = LocalUriHandler.current
            GroupedList(title = stringResource(R.string.about_links)) {
                Item(
                    stringResource(R.string.about_download_page),
                    subtitle = stringResource(R.string.about_download_page_note) + "\n" + shownAddress(Product.DOWNLOAD_PAGE_URL),
                    icon = Lucide.Download,
                    onClick = { uri.openUri(Product.DOWNLOAD_PAGE_URL) },
                    modifier = Modifier.testTag("about.download_page"),
                )
                Item(
                    stringResource(R.string.about_repository),
                    subtitle = stringResource(R.string.about_repository_note) + "\n" + shownAddress(Product.REPOSITORY_URL),
                    icon = R.drawable.github_mark,
                    onClick = { uri.openUri(Product.REPOSITORY_URL) },
                    modifier = Modifier.testTag("about.repository"),
                )
            }
        }
        item { Text(stringResource(R.string.about_license, Product.NAME), fontSize = FontTokens.sizeXs.sp, color = LocalTokens.current.textMuted) }
    }
}

/** One of About's version lines. */
internal data class AboutVersionRow(val key: String, val label: Int, val value: String)

/** About's first lines: this app's version, then the connected hub's when there is one. */
internal fun aboutVersionRows(app: String, hub: String?): List<AboutVersionRow> =
    listOfNotNull(
        AboutVersionRow("app_version", R.string.about_app_version, app),
        hub?.let { AboutVersionRow("connected_hub", R.string.about_connected_hub, it) },
    )

/** How About writes an address: without `https://` and a trailing slash. */
internal fun shownAddress(url: String): String = url.removePrefix("https://").removeSuffix("/")

internal val aboutPage = SettingsPageEntry("about") { AboutPage() }
