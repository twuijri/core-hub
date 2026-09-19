package us.i3u.hermesstudio.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import us.i3u.hermesstudio.AboutSettings
import us.i3u.hermesstudio.AccountSettings
import us.i3u.hermesstudio.AccountStudioSettings
import us.i3u.hermesstudio.AppViewModel
import us.i3u.hermesstudio.CompressionStudioSettings
import us.i3u.hermesstudio.DeviceSettings
import us.i3u.hermesstudio.DisplayStudioSettings
import us.i3u.hermesstudio.ErrorNote
import us.i3u.hermesstudio.LoadingRow
import us.i3u.hermesstudio.ManagedUsersSettings
import us.i3u.hermesstudio.ModelProvidersSettings
import us.i3u.hermesstudio.NoticeNote
import us.i3u.hermesstudio.PrivacyStudioSettings
import us.i3u.hermesstudio.ProxyStudioSettings
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.SettingsGroup
import us.i3u.hermesstudio.StudioTopBar
import us.i3u.hermesstudio.UiState
import us.i3u.hermesstudio.UpdateNote
import us.i3u.hermesstudio.isSuperAdmin
import us.i3u.hermesstudio.ui.theme.CoreHub

/** One tab of the Settings page; the order is the web's. */
private data class SettingsTab(val group: SettingsGroup, val label: Int, val superAdminOnly: Boolean = false)

private val SETTINGS_TABS = listOf(
    SettingsTab(SettingsGroup.Account, R.string.settings_tab_current_account),
    SettingsTab(SettingsGroup.Users, R.string.settings_tab_account_management, superAdminOnly = true),
    SettingsTab(SettingsGroup.Webhooks, R.string.settings_tab_webhooks, superAdminOnly = true),
    SettingsTab(SettingsGroup.Display, R.string.settings_tab_display),
    SettingsTab(SettingsGroup.Proxy, R.string.settings_tab_proxy),
    SettingsTab(SettingsGroup.Compression, R.string.settings_tab_compression),
    SettingsTab(SettingsGroup.Privacy, R.string.settings_tab_privacy),
    SettingsTab(SettingsGroup.Models, R.string.settings_tab_models),
    // Phone-only tabs after the web's: this device's own preferences and About.
    SettingsTab(SettingsGroup.Device, R.string.settings_tab_device),
    SettingsTab(SettingsGroup.About, R.string.settings_tab_about),
)

/**
 * The Settings page with the web's tab order: Current Account, Account
 * Management (sa), Webhooks (sa), Display, Proxy, Compression, Privacy, Models.
 * Each tab renders the same section body the dedicated group screen uses.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsPageScreen(state: UiState, viewModel: AppViewModel) {
    val palette = CoreHub.palette
    val tabs = SETTINGS_TABS.filter { !it.superAdminOnly || state.isSuperAdmin }
    val selectedIndex = tabs.indexOfFirst { it.group == state.openGroup }.coerceAtLeast(0)
    val group = tabs[selectedIndex].group

    Scaffold(
        topBar = { StudioTopBar(title = stringResource(R.string.settings_title), onBack = { viewModel.back() }) },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            ScrollableTabRow(
                selectedTabIndex = selectedIndex,
                edgePadding = 8.dp,
                containerColor = MaterialTheme.colorScheme.background,
                contentColor = palette.textPrimary,
                indicator = { positions ->
                    TabRowDefaults.SecondaryIndicator(
                        Modifier.tabIndicatorOffset(positions[selectedIndex]),
                        color = palette.accent,
                    )
                },
                divider = {},
            ) {
                tabs.forEachIndexed { index, tab ->
                    Tab(
                        selected = index == selectedIndex,
                        onClick = { viewModel.selectSettingsTab(tab.group) },
                        text = { Text(stringResource(tab.label), style = MaterialTheme.typography.labelLarge) },
                        selectedContentColor = palette.textPrimary,
                        unselectedContentColor = palette.textSecondary,
                    )
                }
            }
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .imePadding(),
            ) {
                if (state.savingSetting) LoadingRow()
                state.error?.let { ErrorNote(it) { viewModel.dismissError() } }
                state.notice?.let { NoticeNote(it) { viewModel.dismissNotice() } }
                // The manual check lives on the About tab, so its answer has
                // to be visible here too, not only above the composer.
                if (state.update.showNotice) UpdateNote(state.update, viewModel)
                val loading = state.loadingAgentSettings || state.loadingStudioSettings ||
                    state.loadingAccountSettings || state.loadingManagedUsers || state.loadingModelProviders
                if (loading) {
                    LoadingRow()
                } else {
                    when (group) {
                        SettingsGroup.Account -> AccountSettings(state, viewModel)
                        SettingsGroup.Users -> ManagedUsersSettings(state, viewModel)
                        SettingsGroup.Webhooks -> WebhooksSettingsBody(state, viewModel)
                        SettingsGroup.Display -> DisplayStudioSettings(state, viewModel)
                        SettingsGroup.Proxy -> ProxyStudioSettings(state, viewModel)
                        SettingsGroup.Compression -> CompressionStudioSettings(state, viewModel)
                        SettingsGroup.Privacy -> PrivacyStudioSettings(state, viewModel)
                        SettingsGroup.Models -> ModelProvidersSettings(state, viewModel)
                        SettingsGroup.Device -> DeviceSettings(state, viewModel)
                        SettingsGroup.About -> AboutSettings(state, viewModel)
                        else -> AccountStudioSettings(state, viewModel)
                    }
                }
            }
        }
    }
}

/** Webhooks keep their own full screen; the tab is the doorway to it. */
@Composable
fun WebhooksSettingsBody(state: UiState, viewModel: AppViewModel) {
    val palette = CoreHub.palette
    Column(Modifier.fillMaxWidth().padding(16.dp)) {
        Text(stringResource(R.string.webhooks_note), style = MaterialTheme.typography.bodyMedium, color = palette.textSecondary)
        Text(
            stringResource(R.string.webhooks_count, state.webhooks.size),
            style = MaterialTheme.typography.bodyMedium,
            color = palette.textMuted,
            modifier = Modifier.padding(top = 6.dp, bottom = 12.dp),
        )
        Button(onClick = { viewModel.openWebhooks() }) { Text(stringResource(R.string.webhooks_open)) }
    }
}
