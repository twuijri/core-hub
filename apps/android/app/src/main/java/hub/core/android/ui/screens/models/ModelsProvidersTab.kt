package hub.core.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import hub.core.android.ui.components.ConfirmDeleteDialog
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.FormBody
import hub.core.android.ui.components.FormField
import hub.core.android.ui.components.FormKind
import hub.core.android.ui.components.LoadView
import hub.core.android.ui.components.Loader
import hub.core.android.ui.components.deleteTitle
import hub.core.android.ui.components.rememberConfirmDelete
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ConfirmDialog
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.EmptyState
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.SectionTitle
import hub.core.android.ui.kit.Spinner
import hub.core.android.ui.kit.ToggleRow
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Model
import hub.core.client.model.Provider
import hub.core.client.model.ProviderAllOfAuth
import hub.core.client.model.ProviderAllOfCatalogue
import hub.core.client.model.ProviderKind
import hub.core.client.model.ProviderScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Models → Providers: every provider the hub added, by kind; a card opens the provider to be edited,
 * tested, refreshed, signed in to, cleared of its key or removed, and to name its models. Where each
 * list came from is said (§83).
 */
@Composable
internal fun ProvidersTab(ops: ModelOps, loader: Loader<List<Provider>>, isAdmin: Boolean, profileName: String) {
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    var adding by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<Pair<String, BadgeTone>?>(null) }
    var error by remember { mutableStateOf<HubError?>(null) }
    var signingIn by remember { mutableStateOf<Provider?>(null) }
    var opened by remember { mutableStateOf<String?>(null) }
    var refreshingAll by remember { mutableStateOf(false) }
    val refreshing = stringResource(R.string.models_refreshing)
    LoadView(loader) { providers ->
        LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("models.providers")) {
            item { ErrorNotice(error) }
            // Did the runtime take what was configured (ModelsRuntimeCard.kt)?
            item(key = "runtime") { RuntimeCard(ops.profile, isAdmin, providers) }
            note?.let { (text, tone) -> item { NoticeBox(text, tone) } }
            if (isAdmin) item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HubButton(stringResource(R.string.models_add_provider), { adding = true }, icon = Lucide.Plus, kind = ButtonKind.Subtle, size = ControlSize.Md, modifier = Modifier.testTag("models.add"))
                    if (providers.any { it.catalogue.refreshable && it.enabled }) {
                        HubButton(stringResource(R.string.models_refresh_all), {
                            refreshingAll = true
                            scope.launch {
                                var failed: HubError? = null
                                providers.filter { it.catalogue.refreshable && it.enabled }.forEach { p -> ops.refresh(p).onFailure { failed = it as HubError } }
                                error = failed
                                if (failed == null) note = refreshing to BadgeTone.Info
                                delay(2_000)
                                loader.reload()
                                refreshingAll = false
                            }
                        }, icon = Lucide.RefreshCw, kind = ButtonKind.Ghost, size = ControlSize.Md, loading = refreshingAll, modifier = Modifier.testTag("models.refresh_all"))
                    }
                }
            }
            if (providers.isEmpty()) item { EmptyState(stringResource(R.string.models_none), body = stringResource(R.string.models_none_body), icon = Lucide.Box) }
            ProviderKind.entries.forEach { kind ->
                val group = providers.filter { it.kind == kind }
                if (group.isEmpty()) return@forEach
                item(key = "k" + kind.value) { SectionTitle(kindLabel(kind)) }
                group.forEach { p ->
                    item(key = p.id) {
                        HubCard(Modifier.testTag("provider.${p.slug}"), onClick = { opened = p.id }, padding = 14.dp) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Column(Modifier.weight(1f)) {
                                    Text(p.label, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold)
                                    Text(
                                        listOf(
                                            stringResource(if (p.scope == ProviderScope.PROFILE) R.string.models_scope_profile else R.string.models_scope_all),
                                            stringResource(R.string.models_count, p.models.size),
                                        ).joinToString(" · "),
                                        fontSize = FontTokens.sizeXs.sp, color = t.textMuted,
                                    )
                                    if (p.catalogue.source == ProviderAllOfCatalogue.Source.FALLBACK) {
                                        Text(stringResource(R.string.models_list_fallback_short), fontSize = FontTokens.sizeXs.sp, color = t.warningSoftText)
                                    }
                                }
                                ProviderStatusBadge(p)
                            }
                        }
                    }
                }
            }
        }
        providers.firstOrNull { it.id == opened }?.let { p ->
            ProviderSheet(ops, p, isAdmin, profileName, onChanged = loader.reload, onSignIn = { opened = null; signingIn = it }, onDismiss = { opened = null })
        }
        if (adding) AddProviderSheet(ops, providers, profileName, onDone = { added ->
            adding = false
            loader.reload()
            if (added?.auth?.kind == ProviderAllOfAuth.Kind.OAUTH) signingIn = added
        })
    }
    signingIn?.let { p -> SignInSheet(ops, p, onDone = { signingIn = null; loader.reload() }) }
}

/** A provider's state in one word: needs a sign-in or a key, signed in, off, or on. */
@Composable
internal fun ProviderStatusBadge(p: Provider) = when {
    p.auth.kind == ProviderAllOfAuth.Kind.OAUTH && !p.auth.signedIn -> Badge(stringResource(R.string.models_sign_in_needed), tone = BadgeTone.Warning, dot = true)
    p.auth.kind == ProviderAllOfAuth.Kind.API_KEY && p.apiKey == null -> Badge(stringResource(R.string.models_key_needed), tone = BadgeTone.Warning, dot = true)
    p.auth.kind == ProviderAllOfAuth.Kind.OAUTH -> Badge(stringResource(R.string.models_is_signed_in), tone = if (p.enabled) BadgeTone.Success else BadgeTone.Neutral, dot = true)
    else -> Badge(stringResource(if (p.enabled) R.string.agent_on else R.string.agent_off), tone = if (p.enabled) BadgeTone.Success else BadgeTone.Neutral, dot = true)
}

private sealed interface ProviderMode {
    data object Detail : ProviderMode
    data object Edit : ProviderMode
    data class Alias(val model: Model) : ProviderMode
}

/** One provider: what it is, where its list came from, what can be done with it, and its models. */
@Composable
private fun ProviderSheet(ops: ModelOps, initial: Provider, isAdmin: Boolean, profileName: String, onChanged: () -> Unit, onSignIn: (Provider) -> Unit, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    var provider by remember(initial.id) { mutableStateOf(initial) }
    var mode by remember { mutableStateOf<ProviderMode>(ProviderMode.Detail) }
    var note by remember { mutableStateOf<Pair<String, BadgeTone>?>(null) }
    var error by remember { mutableStateOf<HubError?>(null) }
    var busy by remember { mutableStateOf(false) }
    var clearing by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val deleting = rememberConfirmDelete<Provider>()
    val okText = stringResource(R.string.models_test_ok)
    val failedText = stringResource(R.string.models_test_failed)
    val testingText = stringResource(R.string.models_testing)
    val refreshingText = stringResource(R.string.models_refreshing)
    val refreshedText = stringResource(R.string.models_refreshed)

    suspend fun reload() {
        ops.providers().onSuccess { list -> list.firstOrNull { it.id == provider.id }?.let { provider = it } }.onFailure { error = it as HubError }
    }
    fun patch(body: hub.core.client.model.ProviderPatch) {
        busy = true
        scope.launch {
            ops.update(provider, body).onSuccess { provider = it; error = null; onChanged() }.onFailure { error = it as HubError }
            busy = false
        }
    }

    HubSheet(onDismiss = onDismiss, title = provider.label) {
        when (val m = mode) {
            ProviderMode.Edit -> FormBody(
                fields = listOf(
                    FormField("label", stringResource(R.string.models_label), required = true),
                    FormField("base_url", stringResource(R.string.models_base_url), placeholder = "https://", mono = true),
                    FormField(
                        "key", stringResource(if (provider.auth.kind == ProviderAllOfAuth.Kind.API_KEY) R.string.models_key else R.string.models_key_optional), FormKind.Secret,
                        help = stringResource(if (provider.apiKey != null) R.string.models_key_replace_hint else R.string.models_key_hint), mono = true,
                    ),
                ),
                initial = mapOf("label" to provider.label, "base_url" to provider.baseUrl.orEmpty(), "key" to ""),
                onDone = { mode = ProviderMode.Detail },
                onSave = { values ->
                    ops.update(provider, ModelRules.edit(provider, values["label"].orEmpty(), values["base_url"].orEmpty(), values["key"].orEmpty(), provider.enabled))
                        .onSuccess { provider = it; onChanged() }
                },
                tag = "provider.form",
            )
            is ProviderMode.Alias -> FormBody(
                fields = listOf(FormField("alias", stringResource(R.string.models_alias), help = stringResource(R.string.models_alias_empty, m.model.model), placeholder = m.model.model)),
                initial = mapOf("alias" to m.model.alias.orEmpty()),
                onDone = { mode = ProviderMode.Detail },
                onSave = { values ->
                    ops.setAlias(provider, m.model.model, values["alias"].orEmpty()).also { saved ->
                        if (saved.isSuccess) {
                            reload()
                            onChanged()
                        }
                    }
                },
                intro = m.model.model,
                tag = "model.alias",
            )
            ProviderMode.Detail -> Column(Modifier.heightIn(max = 620.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(provider.slug, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, modifier = Modifier.weight(1f))
                    ProviderStatusBadge(provider)
                }
                ErrorNotice(error)
                note?.let { (text, tone) -> NoticeBox(text, tone, Modifier.testTag("provider.note")) }
                GroupedList {
                    Item(stringResource(R.string.models_for_whom), value = if (provider.scope == ProviderScope.PROFILE) stringResource(R.string.models_scope_only, profileName) else stringResource(R.string.models_scope_all))
                    Item(stringResource(R.string.models_kind), value = kindLabel(provider.kind))
                    Item(stringResource(R.string.models_base_url), value = provider.baseUrl ?: "—")
                    if (provider.auth.kind != ProviderAllOfAuth.Kind.OAUTH) {
                        Item(
                            stringResource(R.string.models_key), value = stringResource(
                                when {
                                    provider.apiKey != null -> R.string.models_key_stored
                                    provider.auth.kind == ProviderAllOfAuth.Kind.API_KEY -> R.string.models_key_missing
                                    else -> R.string.models_key_not_needed
                                },
                            ),
                        )
                    }
                    provider.catalogue.refreshedAt?.let { Item(stringResource(R.string.models_refreshed_at), value = localTime(it)) }
                }
                ModelRules.catalogueNotes(provider).forEach { item ->
                    when (item) {
                        ModelRules.CatalogueNote.Refreshing -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Spinner(14.dp, t.textMuted)
                            Text(refreshingText, fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
                        }
                        is ModelRules.CatalogueNote.Failed -> NoticeBox(item.error, BadgeTone.Danger)
                        is ModelRules.CatalogueNote.Fallback ->
                            NoticeBox(stringResource(R.string.models_list_fallback, item.reason ?: "—"), BadgeTone.Warning, Modifier.testTag("provider.catalogue_fallback"))
                        ModelRules.CatalogueNote.FromAccount ->
                            NoticeBox(stringResource(R.string.models_list_from_account, provider.label), BadgeTone.Info, Modifier.testTag("provider.catalogue_account"))
                    }
                }
                // A subscription through Core Hub's gateway (§143): its accounts and their usage.
                if (provider.subscription != null) ProviderAccountsBlock(ops, provider, isAdmin)
                if (isAdmin) {
                    ToggleRow(stringResource(R.string.models_enabled), provider.enabled, { on -> patch(hub.core.client.model.ProviderPatch(enabled = on)) }, Modifier.testTag("provider.enabled"), enabled = !busy)
                    GroupedList {
                        Item(stringResource(R.string.models_edit), icon = Lucide.Pencil, chevron = true, tag = "provider.edit", onClick = { mode = ProviderMode.Edit })
                        if (provider.auth.kind == ProviderAllOfAuth.Kind.OAUTH) {
                            Item(
                                stringResource(if (provider.auth.signedIn) R.string.models_sign_in_again else R.string.models_sign_in), icon = Lucide.KeyRound, chevron = true,
                                tag = "provider.sign_in", onClick = { onSignIn(provider) },
                            )
                        }
                        if (provider.subscription == null) Item(stringResource(R.string.models_test), icon = Lucide.Activity, tag = "provider.test", onClick = if (busy) null else ({
                            busy = true
                            note = testingText to BadgeTone.Info
                            scope.launch {
                                val answer = ops.test(provider)
                                answer.onSuccess { r ->
                                    note = (if (r.ok) okText.format(r.durationMs) else "${r.message ?: failedText} (${r.durationMs} ms)") to (if (r.ok) BadgeTone.Success else BadgeTone.Danger)
                                }.onFailure { note = null; error = it as HubError }
                                if (answer.isSuccess) reload()
                                busy = false
                            }
                        }))
                        if (provider.catalogue.refreshable) {
                            Item(stringResource(R.string.models_refresh), icon = Lucide.RefreshCw, tag = "provider.refresh", onClick = if (busy) null else ({
                                busy = true
                                scope.launch {
                                    val asked = ops.refresh(provider)
                                    asked.onFailure { error = it as HubError }
                                    if (asked.isSuccess) {
                                        note = refreshingText to BadgeTone.Info
                                        for (attempt in 1..10) {
                                            delay(1_500)
                                            reload()
                                            if (provider.catalogue.status != ProviderAllOfCatalogue.Status.LOADING) break
                                        }
                                        note = if (provider.catalogue.status == ProviderAllOfCatalogue.Status.ERROR) null else refreshedText.format(provider.models.size) to BadgeTone.Success
                                        onChanged()
                                    }
                                    busy = false
                                }
                            }))
                        }
                        if (provider.apiKey != null) Item(stringResource(R.string.models_clear_key), icon = Lucide.X, danger = true, tag = "provider.clear_key", onClick = { clearing = true })
                        Item(stringResource(R.string.presets_delete), icon = Lucide.Trash, danger = true, tag = "provider.delete", onClick = { deleting.ask(provider) })
                    }
                }
                SectionTitle(stringResource(R.string.models_models_of, provider.models.size))
                if (provider.models.size > 8) {
                    HubTextField(query, { query = it }, placeholder = stringResource(R.string.models_search_models), leadingIcon = Lucide.Search, size = ControlSize.Md, fieldTag = "provider.models.search")
                }
                if (provider.models.isEmpty()) Text(stringResource(R.string.models_no_models), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
                val q = query.trim()
                val shown = provider.models.filter { q.isEmpty() || it.model.contains(q, true) || it.alias?.contains(q, true) == true }
                if (shown.isNotEmpty()) GroupedList {
                    shown.forEach { m ->
                        val marks = listOfNotNull(
                            stringResource(R.string.models_image_only).takeIf { m.imageOnly == true },
                            stringResource(R.string.models_hidden).takeIf { !m.visible },
                            stringResource(R.string.agent_off).takeIf { m.disabled },
                        ).joinToString(" · ").ifEmpty { null }
                        Item(
                            m.alias ?: m.model, subtitle = m.model.takeIf { m.alias != null }, value = marks, chevron = isAdmin, tag = "provider.model.${m.model}",
                            onClick = if (isAdmin) ({ mode = ProviderMode.Alias(m) }) else null,
                        )
                    }
                }
                if (isAdmin && provider.models.isNotEmpty()) Text(stringResource(R.string.models_alias_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            }
        }
    }
    ConfirmDeleteDialog(deleting, { deleteTitle(it.label) }, onDelete = { ops.delete(it) }, onDeleted = { onChanged(); onDismiss() })
    if (clearing) {
        ConfirmDialog(
            stringResource(R.string.models_clear_key_confirm, provider.label), stringResource(R.string.models_clear_key_body), stringResource(R.string.models_clear_key),
            onConfirm = { clearing = false; patch(hub.core.client.model.ProviderPatch(apiKey = "")) }, onDismiss = { clearing = false }, danger = true,
        )
    }
}
