package hub.core.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.generated.FontTokens
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.Custom
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.Spinner
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Provider
import hub.core.client.model.ProviderAccount
import hub.core.client.model.ProviderAccounts
import hub.core.client.model.ProviderScope
import hub.core.client.model.SubscriptionVendor
import hub.core.client.model.SubscriptionVendors
import hub.core.client.model.UsageWindow
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * A subscription signed in to through Core Hub's gateway (DECISIONS §143), on the phone: the
 * provider's sheet lists its accounts as the web's dialog does — who, how each stands, its usage
 * windows with what is left and when each resets, its requests, the vendor's last words — with
 * «Check now». A hub without it (404) shows nothing new.
 */
@Composable
internal fun ProviderAccountsBlock(ops: ModelOps, provider: Provider, isAdmin: Boolean) {
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    var answer by remember(provider.id) { mutableStateOf<ProviderAccounts?>(null) }
    var error by remember(provider.id) { mutableStateOf<HubError?>(null) }
    var checking by remember(provider.id) { mutableStateOf<String?>(null) }
    suspend fun load() {
        ops.accounts(provider).onSuccess { answer = it; error = null }.onFailure { error = it as HubError }
    }
    LaunchedEffect(provider.id) { load() }

    Column(Modifier.fillMaxWidth().testTag("provider.accounts"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ErrorNotice(error)
        val a = answer
        when {
            a == null && error == null -> Spinner(14.dp, t.textMuted)
            a != null && !a.available -> NoticeBox(stringResource(R.string.subscriptions_unavailable, a.reason ?: "—"), BadgeTone.Warning)
            a != null && a.accounts.isEmpty() -> Text(stringResource(R.string.subscriptions_none), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
        }
        if (a != null && a.accounts.isNotEmpty()) {
            GroupedList(title = stringResource(R.string.subscriptions_accounts)) {
                a.accounts.forEach { account ->
                    Custom(Modifier.testTag("provider.account.${account.id}")) {
                        AccountRow(account)
                        if (isAdmin) {
                            HubButton(
                                stringResource(R.string.subscriptions_check),
                                {
                                    checking = account.id
                                    scope.launch {
                                        ops.checkAccount(provider, account.id).onFailure { error = it as HubError }
                                        load()
                                        checking = null
                                    }
                                },
                                kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.RefreshCw,
                                loading = checking == account.id, enabled = checking == null,
                                modifier = Modifier.testTag("provider.account.check"),
                            )
                        }
                    }
                }
            }
        }
        if (a != null && a.errors.isNotEmpty()) {
            GroupedList(title = stringResource(R.string.subscriptions_errors)) {
                a.errors.take(5).forEach { item ->
                    Item(item.message, subtitle = listOfNotNull(item.status?.toString(), item.model).joinToString(" · ").ifEmpty { null })
                }
            }
        }
    }
}

@Composable
private fun AccountRow(account: ProviderAccount) {
    val t = LocalTokens.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(account.label, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.Medium, color = t.text, modifier = Modifier.weight(1f))
        account.plan?.let { Badge(it) }
        Badge(stringResource(statusText(account.status)), tone = statusTone(account.status), modifier = Modifier.testTag("provider.account.status"))
    }
    account.statusMessage?.let { Text(it, fontSize = FontTokens.sizeXs.sp, color = t.textMuted) }
    account.nextRetryAt?.let { Text(stringResource(R.string.subscriptions_retry_at, localTime(it)), fontSize = FontTokens.sizeXs.sp) }
    if (account.windows.isEmpty()) {
        Text(stringResource(R.string.subscriptions_no_windows), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
    }
    account.windows.forEach { window -> WindowRow(window) }
    account.checkError?.let { NoticeBox(stringResource(R.string.subscriptions_check_failed, it), BadgeTone.Warning) }
    Text(
        stringResource(R.string.subscriptions_requests, account.requests.success.toString(), account.requests.failed.toString()),
        fontSize = FontTokens.sizeXs.sp, color = t.textMuted, modifier = Modifier.testTag("provider.account.requests"),
    )
}

@Composable
private fun WindowRow(window: UsageWindow) {
    val t = LocalTokens.current
    val used = window.usedPercent?.toDouble()?.coerceIn(0.0, 100.0)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(window.label ?: window.id, fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.Medium, color = t.text)
            if (used != null) {
                Text(
                    stringResource(R.string.subscriptions_left, (100 - used).roundToInt().toString()),
                    fontSize = FontTokens.sizeXs.sp, color = t.text, modifier = Modifier.testTag("provider.account.left"),
                )
            }
            Box(Modifier.weight(1f))
            window.resetsAt?.let { Text(stringResource(R.string.subscriptions_resets, localTime(it)), fontSize = FontTokens.sizeXs.sp, color = t.textMuted) }
        }
        if (used != null) {
            // A plain bar on the tokens: the used part from the reading direction's start.
            Box(Modifier.fillMaxWidth().height(6.dp).background(t.surface2, RoundedCornerShape(3.dp))) {
                Box(
                    Modifier.fillMaxWidth((used / 100.0).toFloat()).height(6.dp)
                        .background(if (used >= 90) t.danger else t.accent, RoundedCornerShape(3.dp)),
                )
            }
        }
    }
}

private fun statusText(status: ProviderAccount.Status): Int = when (status) {
    ProviderAccount.Status.ACTIVE -> R.string.subscriptions_status_active
    ProviderAccount.Status.COOLING -> R.string.subscriptions_status_cooling
    ProviderAccount.Status.ERROR -> R.string.subscriptions_status_error
    ProviderAccount.Status.DISABLED -> R.string.subscriptions_status_disabled
    ProviderAccount.Status.REFRESHING -> R.string.subscriptions_status_refreshing
    ProviderAccount.Status.UNKNOWN -> R.string.subscriptions_status_unknown
}

private fun statusTone(status: ProviderAccount.Status): BadgeTone = when (status) {
    ProviderAccount.Status.ACTIVE -> BadgeTone.Success
    ProviderAccount.Status.COOLING, ProviderAccount.Status.REFRESHING -> BadgeTone.Warning
    ProviderAccount.Status.ERROR -> BadgeTone.Danger
    ProviderAccount.Status.DISABLED, ProviderAccount.Status.UNKNOWN -> BadgeTone.Neutral
}

/**
 * «Add provider → Sign in with a subscription»: the vendors the hub's gateway signs in to. A
 * subscription added before in the same scope is signed in to again. Nothing on a hub without it.
 */
@Composable
internal fun SubscriptionVendorsGroup(
    ops: ModelOps,
    added: List<Provider>,
    shared: ProviderScope,
    onChosen: (Provider) -> Unit,
    onAvailable: (Boolean) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    var vendors by remember(ops.profile) { mutableStateOf<SubscriptionVendors?>(null) }
    var error by remember { mutableStateOf<HubError?>(null) }
    var busy by remember { mutableStateOf(false) }
    // An older hub has no such list (404): nothing to offer, nothing to say.
    LaunchedEffect(ops.profile) {
        vendors = ops.subscriptionVendors().getOrNull()
        onAvailable(vendors?.available == true)
    }
    val list = vendors ?: return
    if (list.items.isEmpty()) return
    ErrorNotice(error)
    if (!list.available) NoticeBox(stringResource(R.string.subscriptions_unavailable, list.reason ?: "—"), BadgeTone.Warning)
    GroupedList(title = stringResource(R.string.subscriptions_title)) {
        list.items.forEach { vendor: SubscriptionVendor ->
            Item(
                vendor.label, chevron = true, tag = "subscription.${vendor.vendor}",
                subtitle = stringResource(if (vendor.flow == SubscriptionVendor.Flow.DEVICE) R.string.subscriptions_flow_device else R.string.subscriptions_flow_link),
                onClick = if (!list.available || busy) null else ({
                    val existing = added.firstOrNull { it.slug == vendor.preset && it.scope == shared }
                    if (existing != null) {
                        onChosen(existing)
                    } else {
                        busy = true
                        scope.launch {
                            ops.create(
                                hub.core.client.model.ProviderCreate(label = vendor.label, kind = hub.core.client.model.ProviderKind.LLM, preset = vendor.preset, scope = shared),
                            ).onSuccess(onChosen).onFailure { error = it as HubError }
                            busy = false
                        }
                    }
                }),
            )
        }
    }
    list.note?.let { Text(it, fontSize = FontTokens.sizeXs.sp, color = LocalTokens.current.textMuted) }
}
