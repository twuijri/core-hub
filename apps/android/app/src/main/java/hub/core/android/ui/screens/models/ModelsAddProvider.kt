package hub.core.android.ui.screens

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.generated.FontTokens
import hub.core.android.generated.RadiusTokens
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.LoadView
import hub.core.android.ui.components.Loading
import hub.core.android.ui.components.rememberLoad
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.Segment
import hub.core.android.ui.kit.Segmented
import hub.core.android.ui.kit.Spinner
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Provider
import hub.core.client.model.ProviderHost
import hub.core.client.model.ProviderKind
import hub.core.client.model.ProviderPreset
import hub.core.client.model.ProviderScope
import hub.core.client.model.ProviderSignIn
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The key as a secret, with the eye to show it; LTR monospace. */
@Composable
internal fun ProviderKeyField(key: String, onKey: (String) -> Unit, label: String) {
    var shown by remember { mutableStateOf(false) }
    HubTextField(
        key, onKey, label = label, mono = true, size = ControlSize.Md, fieldTag = "provider.key",
        visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
        trailing = {
            HubIconButton(
                if (shown) Lucide.EyeOff else Lucide.Eye, stringResource(if (shown) R.string.models_hide_key else R.string.models_show_key), { shown = !shown },
                size = 28.dp, iconSize = 16.dp,
            )
        },
    )
}

/** A base URL field, and the loopback warning under it when the hub runs in a container. */
@Composable
private fun BaseUrlField(url: String, onUrl: (String) -> Unit, placeholder: String?, host: ProviderHost?) {
    HubTextField(url, onUrl, label = stringResource(R.string.models_base_url), placeholder = placeholder, mono = true, size = ControlSize.Md, fieldTag = "provider.url")
    ModelRules.loopbackSuggestion(url, host)?.let { NoticeBox(stringResource(R.string.models_loopback, it), BadgeTone.Warning, Modifier.testTag("provider.loopback")) }
}

/**
 * «Add provider», as the web's dialog: who it is for first, then a preset (by key, by signing in, a
 * local one) or a custom OpenAI-compatible endpoint; a preset already added in that scope is not
 * offered again.
 */
@Composable
internal fun AddProviderSheet(ops: ModelOps, added: List<Provider>, profileName: String, onDone: (Provider?) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val presets = rememberLoad(ops.profile, "presets") { ops.presets().getOrThrow() }
    var shared by remember { mutableStateOf(ProviderScope.ALL) }
    var chosen by remember { mutableStateOf<ProviderPreset?>(null) }
    var custom by remember { mutableStateOf(false) }
    var customKind by remember { mutableStateOf(ProviderKind.LLM) }
    var label by remember { mutableStateOf("") }
    var key by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<HubError?>(null) }
    val probe = rememberProbe(chosen?.id, custom)
    fun send(body: hub.core.client.model.ProviderCreate) {
        busy = true
        scope.launch {
            ops.create(body).onSuccess { made ->
                // A chat model picked from Fetch becomes the default (ModelsProbe.kt).
                ops.applyPicked(made, probe)?.onFailure { error = it as HubError }
                onDone(made)
            }.onFailure { error = it as HubError }
            busy = false
        }
    }
    HubSheet(onDismiss = { onDone(null) }, title = stringResource(R.string.models_add_provider)) {
        LoadView(presets) { answer ->
            val p = chosen
            val forWhom = if (shared == ProviderScope.ALL) stringResource(R.string.models_scope_all) else stringResource(R.string.models_scope_only, profileName)
            when {
                p == null && !custom -> Column(Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.models_for_whom), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
                    Segmented(
                        listOf(
                            Segment(ProviderScope.ALL, stringResource(R.string.models_scope_all), tag = "provider.scope.all"),
                            Segment(ProviderScope.PROFILE, stringResource(R.string.models_scope_profile), tag = "provider.scope.profile"),
                        ),
                        shared, { shared = it }, Modifier.fillMaxWidth(), size = ControlSize.Sm,
                    )
                    Text(
                        if (shared == ProviderScope.ALL) stringResource(R.string.models_scope_all_hint) else stringResource(R.string.models_scope_profile_hint, profileName),
                        fontSize = FontTokens.sizeXs.sp, color = t.textMuted,
                    )
                    // Subscriptions signed in to through Core Hub's gateway (§143).
                    SubscriptionVendorsGroup(ops, added, shared, onChosen = { onDone(it) })
                    val offered = ModelRules.offered(answer.items, added, shared)
                    ProviderKind.entries.forEach { kind ->
                        val group = offered.filter { it.kind == kind }
                        if (group.isEmpty()) return@forEach
                        GroupedList(title = kindLabel(kind)) {
                            group.forEach { preset ->
                                Item(
                                    preset.label, chevron = true, tag = "preset.${preset.id}",
                                    subtitle = when {
                                        preset.signIn -> stringResource(R.string.models_by_sign_in)
                                        preset.local -> stringResource(R.string.models_local)
                                        ModelRules.keyOnFile(preset, shared) -> stringResource(R.string.models_key_on_file_short)
                                        else -> null
                                    },
                                    onClick = { chosen = preset; baseUrl = preset.baseUrl.orEmpty(); key = ""; error = null },
                                )
                            }
                        }
                    }
                    GroupedList {
                        Item(
                            stringResource(R.string.models_custom), subtitle = stringResource(R.string.models_custom_hint), chevron = true, tag = "preset.custom",
                            onClick = { custom = true; baseUrl = ""; key = ""; label = ""; error = null },
                        )
                    }
                }
                p != null -> Column(Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(p.label, fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold)
                    Text("${stringResource(R.string.models_for_whom)}: $forWhom", fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                    ErrorNotice(error)
                    if (p.signIn) {
                        NoticeBox(stringResource(R.string.models_sign_in_after), BadgeTone.Info)
                    } else {
                        ProviderKeyField(key, { key = it }, stringResource(if (ModelRules.keyOptional(p, shared)) R.string.models_key_optional else R.string.models_key))
                        if (ModelRules.keyOnFile(p, shared)) Text(stringResource(R.string.models_key_on_file), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                        p.keysUrl?.let { url ->
                            HubButton(stringResource(R.string.models_get_key), { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }, kind = ButtonKind.Ghost, size = ControlSize.Sm, icon = Lucide.ExternalLink)
                        }
                    }
                    if (p.baseUrlRequired || p.baseUrl != null) BaseUrlField(baseUrl, { baseUrl = it }, p.baseUrlExample, answer.host)
                    if (!p.signIn) ProbePart(ops, probe, ProbeRules.request(p.id, baseUrl, key, p.kind), chat = p.kind == ProviderKind.LLM)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        HubButton(
                            stringResource(R.string.models_add), { send(ModelRules.create(p, key, baseUrl, shared)) },
                            size = ControlSize.Md, icon = Lucide.Plus, loading = busy, enabled = ModelRules.ready(p, key, baseUrl, shared), modifier = Modifier.testTag("provider.add"),
                        )
                        HubButton(stringResource(R.string.back), { chosen = null; error = null }, kind = ButtonKind.Ghost, size = ControlSize.Md)
                    }
                }
                else -> Column(Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.models_custom), fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold)
                    Text("${stringResource(R.string.models_for_whom)}: $forWhom", fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                    ErrorNotice(error)
                    Text(stringResource(R.string.models_kind), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
                    Segmented(
                        ProviderKind.entries.map { Segment(it, kindLabel(it), tag = "provider.kind.${it.value}") },
                        customKind, { customKind = it }, Modifier.fillMaxWidth(), size = ControlSize.Sm,
                    )
                    HubTextField(label, { label = it }, label = stringResource(R.string.models_label), size = ControlSize.Md, fieldTag = "provider.label")
                    BaseUrlField(baseUrl, { baseUrl = it }, "http://host:8000/v1", answer.host)
                    ProviderKeyField(key, { key = it }, stringResource(R.string.models_key_optional))
                    ProbePart(ops, probe, ProbeRules.request(null, baseUrl, key, customKind), chat = customKind == ProviderKind.LLM)
                    val body = ModelRules.custom(label, customKind, baseUrl, key, shared)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        HubButton(
                            stringResource(R.string.models_add), { body?.let(::send) },
                            size = ControlSize.Md, icon = Lucide.Plus, loading = busy, enabled = body != null, modifier = Modifier.testTag("provider.add"),
                        )
                        HubButton(stringResource(R.string.back), { custom = false; error = null }, kind = ButtonKind.Ghost, size = ControlSize.Md)
                    }
                }
            }
        }
    }
}

/**
 * A sign-in by device code: the code to type on the provider's page, the page, waiting for the
 * answer, and the outcome in words — signed in, declined, ran out, or did not finish; start again.
 */
@Composable
internal fun SignInSheet(ops: ModelOps, provider: Provider, onDone: () -> Unit) {
    val context = LocalContext.current
    val t = LocalTokens.current
    var signIn by remember { mutableStateOf<ProviderSignIn?>(null) }
    var error by remember { mutableStateOf<HubError?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    // A sign-in by link (§143): the address the browser landed on, pasted back.
    var pasted by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    val pasteScope = rememberCoroutineScope()
    LaunchedEffect(provider.id, attempt) {
        signIn = null
        error = null
        ops.signIn(provider).onSuccess { signIn = it }.onFailure { error = it as HubError }
        while (true) {
            val current = signIn ?: break
            if (ModelRules.settled(current)) break
            delay(3_000)
            val next = ops.signInState(provider.id, current.id)
            next.onSuccess { signIn = it }.onFailure { error = it as HubError }
            if (next.isFailure) break
        }
    }
    HubSheet(onDismiss = onDone, title = stringResource(R.string.models_sign_in_to, provider.label)) {
        ErrorNotice(error)
        val s = signIn
        when {
            s == null && error == null -> Loading(Modifier.padding(24.dp))
            s != null && s.status == ProviderSignIn.Status.APPROVED -> NoticeBox(stringResource(R.string.models_sign_in_approved), BadgeTone.Success, Modifier.testTag("signin.approved"))
            s != null && s.status != ProviderSignIn.Status.PENDING -> {
                val head = stringResource(
                    when (s.status) {
                        ProviderSignIn.Status.DENIED -> R.string.models_sign_in_denied
                        ProviderSignIn.Status.EXPIRED -> R.string.models_sign_in_expired
                        else -> R.string.models_sign_in_failed
                    },
                )
                NoticeBox(listOfNotNull(head, s.error).joinToString(" "), BadgeTone.Danger, Modifier.testTag("signin.ended"))
                HubButton(stringResource(R.string.models_sign_in_retry), { attempt++ }, kind = ButtonKind.Secondary, size = ControlSize.Md, icon = Lucide.RotateCcw, modifier = Modifier.testTag("signin.retry"))
            }
            s != null -> {
                Text(stringResource(if (s.acceptsCode) R.string.subscriptions_paste_steps else R.string.models_sign_in_steps), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
                s.userCode?.let { code ->
                    Box(Modifier.fillMaxWidth().background(t.surface2, RoundedCornerShape(RadiusTokens.md.dp)).padding(16.dp), contentAlignment = Alignment.Center) {
                        Text(code, fontSize = FontTokens.sizeXl.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace, modifier = Modifier.testTag("signin.code"))
                    }
                    HubButton(stringResource(R.string.models_copy_code), {
                        (context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager)
                            .setPrimaryClip(ClipData.newPlainText("code", code))
                    }, kind = ButtonKind.Secondary, size = ControlSize.Md, icon = Lucide.Copy)
                }
                HubButton(stringResource(R.string.models_open_sign_in), { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(s.verificationUrl))) }, icon = Lucide.ExternalLink, fill = true, modifier = Modifier.fillMaxWidth().testTag("signin.open"))
                Text(s.verificationUrl, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, fontFamily = FontFamily.Monospace)
                if (s.acceptsCode) {
                    HubTextField(
                        pasted, { pasted = it }, placeholder = s.callbackHint ?: "http://localhost/…", mono = true,
                        label = stringResource(R.string.subscriptions_paste_label), size = ControlSize.Md, fieldTag = "signin.paste",
                    )
                    s.callbackHint?.let { Text(stringResource(R.string.subscriptions_paste_hint, it), fontSize = FontTokens.sizeXs.sp, color = t.textMuted) }
                    HubButton(
                        stringResource(R.string.subscriptions_paste_submit),
                        {
                            sending = true
                            pasteScope.launch {
                                ops.completeSignIn(provider.id, s.id, pasted.trim()).onSuccess { signIn = it }.onFailure { error = it as HubError }
                                sending = false
                            }
                        },
                        enabled = pasted.isNotBlank() && !sending, loading = sending, fill = true,
                        modifier = Modifier.fillMaxWidth().testTag("signin.paste_submit"),
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Spinner(14.dp, t.textMuted)
                    Text(stringResource(R.string.models_waiting_sign_in), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                }
            }
            else -> HubButton(stringResource(R.string.models_sign_in_retry), { attempt++ }, kind = ButtonKind.Secondary, size = ControlSize.Md, icon = Lucide.RotateCcw)
        }
        HubButton(stringResource(R.string.ok), onDone, kind = ButtonKind.Ghost, size = ControlSize.Md)
    }
}
