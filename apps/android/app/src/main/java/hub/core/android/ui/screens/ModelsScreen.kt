package hub.core.android.ui.screens

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.AppLanguage
import hub.core.android.R
import hub.core.android.data.HubApis
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.generated.FontTokens
import hub.core.android.generated.RadiusTokens
import hub.core.android.graph
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.LoadView
import hub.core.android.ui.components.rememberLoad
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ConfirmDialog
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.Custom
import hub.core.android.ui.kit.EmptyState
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubMenu
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.HubSwitch
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.kit.MenuItem
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.SectionTitle
import hub.core.android.ui.kit.Segment
import hub.core.android.ui.kit.Segmented
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Model
import hub.core.client.model.ModelDefaults
import hub.core.client.model.ModelDefaultsWrite
import hub.core.client.model.ModelKind
import hub.core.client.model.ModelRef
import hub.core.client.model.Provider
import hub.core.client.model.ProviderAllOfAuth
import hub.core.client.model.ProviderCreate
import hub.core.client.model.ProviderKind
import hub.core.client.model.ProviderPatch
import hub.core.client.model.ProviderPreset
import hub.core.client.model.ProviderScope
import hub.core.client.model.ProviderSignIn
import hub.core.client.model.SpeechFormat
import hub.core.client.model.SpeechProvider
import hub.core.client.model.SpeechRequest
import hub.core.client.model.SpeechSettingsPatch
import hub.core.client.model.SpeechSettingsPatchProvidersInner
import hub.core.client.model.Voice
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.roundToInt

/** Models on the phone (owner: native, not «open the web»): the rules, apart from the screens. */
object ModelRules {
    /** A fallback chain edited by hand: moved, added once (never the default itself), removed. */
    fun move(list: List<ModelRef>, from: Int, to: Int): List<ModelRef> {
        if (from !in list.indices) return list
        val out = list.toMutableList()
        val item = out.removeAt(from)
        out.add(to.coerceIn(0, out.size), item)
        return out
    }

    fun add(list: List<ModelRef>, ref: ModelRef, default: ModelRef?): List<ModelRef> =
        if (list.any { same(it, ref) } || (default != null && same(default, ref))) list else list + ref

    fun same(a: ModelRef, b: ModelRef) = a.providerId == b.providerId && a.model == b.model

    /** Where a row dragged by [dy] pixels lands, rows being [rowHeight] tall. */
    fun dropIndex(from: Int, dy: Float, rowHeight: Float, size: Int): Int =
        if (rowHeight <= 0f) from else (from + (dy / rowHeight).roundToInt()).coerceIn(0, (size - 1).coerceAtLeast(0))

    /** What adding a provider from [preset] sends: the key and address only where the preset takes them. */
    fun create(preset: ProviderPreset, key: String, baseUrl: String, scope: ProviderScope): ProviderCreate = ProviderCreate(
        label = preset.label,
        kind = preset.kind,
        preset = preset.id,
        apiKey = key.trim().takeIf { it.isNotEmpty() && !preset.signIn },
        baseUrl = baseUrl.trim().takeIf { it.isNotEmpty() },
        scope = scope,
    )

    /** Whether the form can be sent: a required key typed, a required address typed. A sign-in needs neither. */
    fun ready(preset: ProviderPreset, key: String, baseUrl: String): Boolean =
        (preset.signIn || preset.key != ProviderPreset.Key.REQUIRED || key.isNotBlank()) && (!preset.baseUrlRequired || baseUrl.isNotBlank())

    /** A sign-in that will not change any more. */
    fun settled(signIn: ProviderSignIn): Boolean = signIn.status != ProviderSignIn.Status.PENDING

    /**
     * Voices in a short list first: those in the languages the person reads (the app's, then the
     * phone's), then the rest by language and name; the search matches a name, a language or a
     * description. Every language the provider offers stays in the list (DESIGN: global).
     */
    fun voices(all: List<Voice>, preferred: List<String>, query: String): List<Voice> {
        val q = query.trim().lowercase()
        val wanted = preferred.map { it.lowercase().substringBefore('-') }
        fun rank(v: Voice): Int {
            val lang = v.language?.lowercase()?.substringBefore('-') ?: return wanted.size + 1
            val i = wanted.indexOf(lang)
            return if (i >= 0) i else wanted.size
        }
        return all.filter { v ->
            q.isEmpty() || v.name.lowercase().contains(q) || v.language?.lowercase()?.contains(q) == true || v.description?.lowercase()?.contains(q) == true
        }.sortedWith(compareBy<Voice>({ rank(it) }, { it.language ?: "~" }, { it.name.lowercase() }))
    }

    /** A sentence to hear a voice by, in its own language when we have one. */
    fun sample(language: String?, fallback: String): String = when (language?.lowercase()?.substringBefore('-')) {
        "ar" -> "مرحبًا، هذا صوتي في كور هب."
        "en" -> "Hello, this is how I sound in Core Hub."
        "fr" -> "Bonjour, voici ma voix dans Core Hub."
        "es" -> "Hola, así sueno en Core Hub."
        "de" -> "Hallo, so klinge ich in Core Hub."
        else -> fallback
    }

    /** Models a person can pick for chat (never an image-only one, §87), and for drawing. */
    fun chatModels(providers: List<Provider>): List<Model> =
        providers.filter { it.enabled && it.kind == ProviderKind.LLM }.flatMap { p -> p.models.filter { it.kind == ModelKind.CHAT && it.imageOnly != true && !it.disabled } }

    fun imageModels(providers: List<Provider>): List<Model> =
        providers.filter { it.enabled && it.drawsImages == true }.flatMap { p -> p.models.filter { !it.disabled && (it.imageOnly == true || p.drawsImages == true) } }
            .sortedByDescending { it.imageOnly == true }
}

/** What the Models page changes, against the profile the selector is on. */
class ModelOps(private val apis: () -> HubApis?, val profile: String) {
    private suspend fun <T> call(block: suspend (HubApis) -> T): Result<T> {
        val api = apis() ?: return Result.failure(HubError(401, "unauthorized", null))
        return hubCall { block(api) }
    }

    suspend fun providers() = call { it.models.modelsListProviders(profile).items }
    suspend fun presets() = call { it.models.modelsListProviderPresets(profile).items }
    suspend fun create(body: ProviderCreate) = call { it.models.modelsCreateProvider(profile, body) }
    suspend fun setEnabled(p: Provider, on: Boolean) = call { it.models.modelsUpdateProvider(profile, p.id, ProviderPatch(enabled = on)) }
    suspend fun setKey(p: Provider, key: String) = call { it.models.modelsUpdateProvider(profile, p.id, ProviderPatch(apiKey = key.trim())) }
    suspend fun delete(p: Provider) = call { it.models.modelsDeleteProvider(profile, p.id) }
    suspend fun test(p: Provider) = call { it.models.modelsTestProvider(profile, p.id) }
    suspend fun refresh(p: Provider) = call { it.models.modelsRefreshProvider(profile, p.id) }
    suspend fun signIn(p: Provider) = call { it.models.modelsStartProviderSignIn(profile, p.id) }
    suspend fun signInState(providerId: String, id: String) = call { it.models.modelsGetProviderSignIn(profile, providerId, id) }
    suspend fun defaults() = call { it.models.modelsGetDefaults(profile) }
    suspend fun setDefault(ref: ModelRef) = call { it.models.modelsSetDefaults(profile, ModelDefaultsWrite(default = ref)) }
    suspend fun setImage(ref: ModelRef) = call { it.models.modelsSetDefaults(profile, ModelDefaultsWrite(image = ref)) }
    suspend fun setFallbacks(list: List<ModelRef>) = call { it.models.modelsSetDefaults(profile, ModelDefaultsWrite(fallbacks = list)) }
    suspend fun speech() = call { it.models.modelsGetSpeech(profile) }
    suspend fun useSpeech(stt: String? = null, tts: String? = null) = call { it.models.modelsUpdateSpeech(profile, SpeechSettingsPatch(sttProviderId = stt, ttsProviderId = tts)) }
    suspend fun setVoice(provider: String, voice: String) = call {
        it.models.modelsUpdateSpeech(profile, SpeechSettingsPatch(providers = listOf(SpeechSettingsPatchProvidersInner(id = provider, settings = mapOf("voice" to JsonPrimitive(voice))))))
    }
    suspend fun voices(provider: String, model: String?) = call { it.models.modelsListVoices(profile, provider, model).items }
    suspend fun preview(provider: String, voice: String, text: String, language: String?) =
        call { it.models.modelsSynthesize(profile, SpeechRequest(text = text, language = language, voice = voice, providerId = provider, format = SpeechFormat.MP3)) }
}

private enum class ModelsTab { PROVIDERS, DEFAULTS, SPEECH, IMAGES }

@Composable
private fun rememberModelOps(profile: String): ModelOps {
    val context = LocalContext.current
    return remember(profile) { ModelOps({ context.graph.store.current?.let(context.graph::apis) }, profile) }
}

/** Models, native on the phone: providers, defaults with the fallbacks in order, speech and pictures. */
@Composable
fun ModelsPage(profile: String, profileName: String, isAdmin: Boolean) {
    var tab by rememberSaveable { mutableStateOf(ModelsTab.PROVIDERS) }
    val ops = rememberModelOps(profile)
    val providers = rememberLoad(profile, "providers") { ops.providers().getOrThrow() }
    Column(Modifier.fillMaxSize().testTag("models.page")) {
        Segmented(
            listOf(
                Segment(ModelsTab.PROVIDERS, stringResource(R.string.models_tab_providers), tag = "models.tab.providers"),
                Segment(ModelsTab.DEFAULTS, stringResource(R.string.models_tab_defaults), tag = "models.tab.defaults"),
                Segment(ModelsTab.SPEECH, stringResource(R.string.models_tab_speech), tag = "models.tab.speech"),
                Segment(ModelsTab.IMAGES, stringResource(R.string.models_tab_images), tag = "models.tab.images"),
            ),
            tab, { tab = it }, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), size = ControlSize.Sm,
        )
        Text(stringResource(R.string.models_in_profile, profileName), fontSize = FontTokens.sizeXs.sp, color = LocalTokens.current.textMuted, modifier = Modifier.padding(horizontal = 20.dp))
        when (tab) {
            ModelsTab.PROVIDERS -> ProvidersTab(ops, providers.state, providers.reload, isAdmin)
            ModelsTab.DEFAULTS -> LoadView(providers) { list -> DefaultsTab(ops, list, isAdmin) }
            ModelsTab.SPEECH -> SpeechTab(ops, isAdmin)
            ModelsTab.IMAGES -> LoadView(providers) { list -> ImagesTab(ops, list, isAdmin) }
        }
    }
}

@Composable
private fun kindLabel(kind: ProviderKind): String = stringResource(
    when (kind) {
        ProviderKind.LLM -> R.string.models_kind_llm
        ProviderKind.STT -> R.string.models_kind_stt
        ProviderKind.TTS -> R.string.models_kind_tts
    },
)

@Composable
private fun ProvidersTab(ops: ModelOps, state: hub.core.android.ui.components.Load<List<Provider>>, reload: () -> Unit, isAdmin: Boolean) {
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    var adding by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<Pair<String, BadgeTone>?>(null) }
    var error by remember { mutableStateOf<HubError?>(null) }
    var deleting by remember { mutableStateOf<Provider?>(null) }
    var signingIn by remember { mutableStateOf<Provider?>(null) }
    var menu by remember { mutableStateOf<String?>(null) }
    var opened by remember { mutableStateOf<String?>(null) }
    val okText = stringResource(R.string.models_test_ok)
    val refreshing = stringResource(R.string.models_refreshing)
    LoadView(hub.core.android.ui.components.Loader(state, reload)) { providers ->
        LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("models.providers")) {
            item { ErrorNotice(error) }
            note?.let { (text, tone) -> item { NoticeBox(text, tone) } }
            if (isAdmin) item {
                HubButton(stringResource(R.string.models_add_provider), { adding = true }, icon = Lucide.Plus, kind = ButtonKind.Subtle, size = ControlSize.Md, modifier = Modifier.testTag("models.add"))
            }
            if (providers.isEmpty()) item { EmptyState(stringResource(R.string.models_none), body = stringResource(R.string.models_none_body), icon = Lucide.Box) }
            ProviderKind.entries.forEach { kind ->
                val group = providers.filter { it.kind == kind }
                if (group.isEmpty()) return@forEach
                item(key = "k" + kind.value) { SectionTitle(kindLabel(kind)) }
                group.forEach { p ->
                    item(key = p.id) {
                        HubCard(Modifier.testTag("provider.${p.slug}"), onClick = { opened = if (opened == p.id) null else p.id }, padding = 14.dp) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Column(Modifier.weight(1f)) {
                                    Text(p.label, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold)
                                    Text(
                                        listOfNotNull(
                                            stringResource(if (p.scope == ProviderScope.PROFILE) R.string.models_scope_profile else R.string.models_scope_all),
                                            stringResource(R.string.models_count, p.models.size),
                                        ).joinToString(" · "),
                                        fontSize = FontTokens.sizeXs.sp, color = t.textMuted,
                                    )
                                }
                                when {
                                    p.auth.kind == ProviderAllOfAuth.Kind.OAUTH && !p.auth.signedIn -> Badge(stringResource(R.string.models_sign_in_needed), tone = BadgeTone.Warning, dot = true)
                                    p.auth.kind == ProviderAllOfAuth.Kind.API_KEY && p.apiKey == null -> Badge(stringResource(R.string.models_key_needed), tone = BadgeTone.Warning, dot = true)
                                    else -> Badge(stringResource(if (p.enabled) R.string.agent_on else R.string.agent_off), tone = if (p.enabled) BadgeTone.Success else BadgeTone.Neutral, dot = true)
                                }
                                if (isAdmin) Box {
                                    HubIconButton(Lucide.Ellipsis, stringResource(R.string.chat_more), { menu = p.id }, size = 32.dp, iconSize = 16.dp, modifier = Modifier.testTag("provider.${p.slug}.more"))
                                    HubMenu(menu == p.id, { menu = null }) {
                                        MenuItem(stringResource(if (p.enabled) R.string.models_turn_off else R.string.models_turn_on), {
                                            menu = null
                                            scope.launch { ops.setEnabled(p, !p.enabled).onFailure { error = it as HubError }; reload() }
                                        }, icon = Lucide.Power)
                                        MenuItem(stringResource(R.string.mcp_test), {
                                            menu = null
                                            scope.launch {
                                                ops.test(p).onSuccess { r -> note = (if (r.ok) okText.format(r.durationMs) else r.message ?: "—") to (if (r.ok) BadgeTone.Success else BadgeTone.Danger) }
                                                    .onFailure { error = it as HubError }
                                            }
                                        }, icon = Lucide.Activity)
                                        MenuItem(stringResource(R.string.models_refresh), {
                                            menu = null
                                            scope.launch { ops.refresh(p).onSuccess { note = refreshing to BadgeTone.Info }.onFailure { error = it as HubError } }
                                        }, icon = Lucide.RefreshCw)
                                        if (p.auth.kind == ProviderAllOfAuth.Kind.OAUTH) {
                                            MenuItem(stringResource(R.string.models_sign_in), { menu = null; signingIn = p }, icon = Lucide.KeyRound)
                                        }
                                        MenuItem(stringResource(R.string.presets_delete), { menu = null; deleting = p }, icon = Lucide.Trash, danger = true)
                                    }
                                }
                            }
                            if (opened == p.id) {
                                p.models.take(40).forEach { m ->
                                    Text(m.alias ?: m.model, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, fontFamily = FontFamily.Monospace)
                                }
                                if (p.models.size > 40) Text("+${p.models.size - 40}", fontSize = FontTokens.sizeXs.sp, color = t.textFaint)
                            }
                        }
                    }
                }
            }
        }
    }
    if (adding) AddProviderSheet(ops, onDone = { added -> adding = false; reload(); if (added?.auth?.kind == ProviderAllOfAuth.Kind.OAUTH) signingIn = added })
    signingIn?.let { p -> SignInSheet(ops, p, onDone = { signingIn = null; reload() }) }
    deleting?.let { p ->
        ConfirmDialog(
            stringResource(R.string.models_delete_confirm, p.label), stringResource(R.string.models_delete_body), stringResource(R.string.presets_delete),
            onConfirm = { scope.launch { ops.delete(p).onFailure { error = it as HubError }; reload() }; deleting = null }, onDismiss = { deleting = null }, danger = true,
        )
    }
}

/** «Add provider»: the kinds the hub can add; a key, an address where needed, and who it is for. */
@Composable
private fun AddProviderSheet(ops: ModelOps, onDone: (Provider?) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val presets = rememberLoad(ops.profile, "presets") { ops.presets().getOrThrow() }
    var chosen by remember { mutableStateOf<ProviderPreset?>(null) }
    var key by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("") }
    var shared by remember { mutableStateOf(ProviderScope.ALL) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<HubError?>(null) }
    HubSheet(onDismiss = { onDone(null) }, title = stringResource(R.string.models_add_provider)) {
        val p = chosen
        if (p == null) {
            LoadView(presets) { list ->
                Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState())) {
                    ProviderKind.entries.forEach { kind ->
                        val group = list.filter { it.kind == kind }
                        if (group.isEmpty()) return@forEach
                        GroupedList(title = kindLabel(kind)) {
                            group.forEach { preset ->
                                Item(
                                    preset.label, chevron = true, tag = "preset.${preset.id}",
                                    subtitle = when {
                                        preset.signIn -> stringResource(R.string.models_by_sign_in)
                                        preset.local -> stringResource(R.string.models_local)
                                        else -> null
                                    },
                                    onClick = { chosen = preset; baseUrl = preset.baseUrl.orEmpty() },
                                )
                            }
                        }
                    }
                }
            }
        } else {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(p.label, fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold)
                ErrorNotice(error)
                if (p.signIn) NoticeBox(stringResource(R.string.models_sign_in_after), BadgeTone.Info)
                if (!p.signIn) {
                    HubTextField(
                        key, { key = it }, label = stringResource(if (p.key == ProviderPreset.Key.REQUIRED) R.string.models_key else R.string.models_key_optional),
                        mono = true, visualTransformation = PasswordVisualTransformation(), size = ControlSize.Md, fieldTag = "provider.key",
                    )
                    p.keysUrl?.let { url ->
                        HubButton(stringResource(R.string.models_get_key), { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }, kind = ButtonKind.Ghost, size = ControlSize.Sm, icon = Lucide.ExternalLink)
                    }
                }
                if (p.baseUrlRequired || p.baseUrl != null) {
                    HubTextField(baseUrl, { baseUrl = it }, label = stringResource(R.string.models_base_url), placeholder = p.baseUrlExample, mono = true, size = ControlSize.Md, fieldTag = "provider.url")
                }
                Text(stringResource(R.string.models_for_whom), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
                Segmented(
                    listOf(
                        Segment(ProviderScope.ALL, stringResource(R.string.models_scope_all)),
                        Segment(ProviderScope.PROFILE, stringResource(R.string.models_scope_profile)),
                    ),
                    shared, { shared = it }, Modifier.fillMaxWidth(), size = ControlSize.Sm,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HubButton(stringResource(R.string.models_add), {
                        busy = true
                        scope.launch {
                            ops.create(ModelRules.create(p, key, baseUrl, shared)).onSuccess { onDone(it) }.onFailure { error = it as HubError }
                            busy = false
                        }
                    }, size = ControlSize.Md, icon = Lucide.Plus, loading = busy, enabled = ModelRules.ready(p, key, baseUrl), modifier = Modifier.testTag("provider.add"))
                    HubButton(stringResource(R.string.back), { chosen = null; error = null }, kind = ButtonKind.Ghost, size = ControlSize.Md)
                }
            }
        }
    }
}

/** A sign-in by device code: the code to type on the provider's page, the page, and waiting for the answer. */
@Composable
private fun SignInSheet(ops: ModelOps, provider: Provider, onDone: () -> Unit) {
    val context = LocalContext.current
    val t = LocalTokens.current
    var signIn by remember { mutableStateOf<ProviderSignIn?>(null) }
    var error by remember { mutableStateOf<HubError?>(null) }
    LaunchedEffect(provider.id) {
        ops.signIn(provider).onSuccess { signIn = it }.onFailure { error = it as HubError }
        while (true) {
            val current = signIn ?: break
            if (ModelRules.settled(current)) break
            delay(3_000)
            ops.signInState(provider.id, current.id).onSuccess { signIn = it }.onFailure { error = it as HubError; return@LaunchedEffect }
        }
    }
    HubSheet(onDismiss = onDone, title = stringResource(R.string.models_sign_in_to, provider.label)) {
        ErrorNotice(error)
        val s = signIn
        when {
            s == null && error == null -> hub.core.android.ui.components.Loading(Modifier.padding(24.dp))
            s != null && s.status == ProviderSignIn.Status.APPROVED -> NoticeBox(stringResource(R.string.models_signed_in), BadgeTone.Success)
            s != null && s.status != ProviderSignIn.Status.PENDING -> NoticeBox(s.error ?: stringResource(R.string.models_sign_in_failed), BadgeTone.Danger)
            s != null -> {
                Text(stringResource(R.string.models_sign_in_steps), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
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
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    hub.core.android.ui.kit.Spinner(14.dp, t.textMuted)
                    Text(stringResource(R.string.models_waiting_sign_in), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                }
            }
        }
        HubButton(stringResource(R.string.ok), onDone, kind = ButtonKind.Ghost, size = ControlSize.Md)
    }
}

/** A model picker: every chat model of the profile, by provider. */
@Composable
private fun ModelPickerSheet(title: String, models: List<Model>, providers: List<Provider>, onPick: (ModelRef) -> Unit, onDismiss: () -> Unit) {
    var query by remember { mutableStateOf("") }
    HubSheet(onDismiss = onDismiss, title = title) {
        HubTextField(query, { query = it }, placeholder = stringResource(R.string.search), leadingIcon = Lucide.Search, size = ControlSize.Md, fieldTag = "model.search")
        Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState())) {
            models.filter { query.isBlank() || it.model.contains(query.trim(), true) || it.alias?.contains(query.trim(), true) == true }
                .groupBy { it.providerId }.forEach { (providerId, list) ->
                    GroupedList(title = providers.firstOrNull { it.id == providerId }?.label ?: list.first().provider) {
                        list.forEach { m -> Item(m.alias ?: m.model, tag = "model.${m.key}", onClick = { onPick(ModelRef(m.providerId, m.model)) }) }
                    }
                }
        }
    }
}

private fun label(ref: ModelRef?, providers: List<Provider>): String? = ref?.let { r ->
    val p = providers.firstOrNull { it.id == r.providerId }
    val alias = p?.models?.firstOrNull { it.model == r.model }?.alias
    "${alias ?: r.model} · ${p?.label ?: r.providerId}"
}

/** Defaults: the chat model, then the fallbacks in the order they are tried — dragged by their handle. */
@Composable
private fun DefaultsTab(ops: ModelOps, providers: List<Provider>, isAdmin: Boolean) {
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val density = androidx.compose.ui.platform.LocalDensity.current
    val load = rememberLoad(ops.profile, "defaults") { ops.defaults().getOrThrow() }
    var picking by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<HubError?>(null) }
    val chat = remember(providers) { ModelRules.chatModels(providers) }
    LoadView(load) { d ->
        var order by remember(d) { mutableStateOf(d.fallbacks) }
        var dragging by remember { mutableIntStateOf(-1) }
        var dy by remember { mutableFloatStateOf(0f) }
        var rowHeight by remember { mutableFloatStateOf(0f) }
        fun save(list: List<ModelRef>) {
            order = list
            scope.launch { ops.setFallbacks(list).onFailure { error = it as HubError }; load.reload() }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp).testTag("models.defaults"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ErrorNotice(error)
            if (!d.inherited.isNullOrEmpty()) NoticeBox(stringResource(R.string.models_inherited), BadgeTone.Info)
            GroupedList(title = stringResource(R.string.models_default)) {
                Item(
                    label(d.default, providers) ?: stringResource(R.string.models_none_chosen), icon = Lucide.Sparkles,
                    chevron = isAdmin, tag = "defaults.default", onClick = if (isAdmin) ({ picking = "default" }) else null,
                )
            }
            SectionTitle(stringResource(R.string.models_fallbacks))
            Text(stringResource(R.string.models_fallbacks_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                order.forEachIndexed { i, ref ->
                    val lifted = dragging == i
                    Row(
                        Modifier.fillMaxWidth()
                            .onGloballyPositioned { if (rowHeight == 0f) rowHeight = it.size.height + with(density) { 6.dp.toPx() } }
                            .then(if (lifted) Modifier.offset { IntOffset(0, dy.roundToInt()) }.shadow(8.dp, RoundedCornerShape(RadiusTokens.md.dp)) else Modifier)
                            .background(t.surface, RoundedCornerShape(RadiusTokens.md.dp))
                            .padding(horizontal = 10.dp, vertical = 10.dp)
                            .testTag("fallback.$i"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        if (isAdmin) {
                            LucideIcon(
                                Lucide.GripVertical, stringResource(R.string.models_drag), size = 18.dp, tint = t.textFaint,
                                modifier = Modifier.pointerInput(order) {
                                    detectDragGesturesAfterLongPress(
                                        onDragStart = { dragging = i; dy = 0f },
                                        onDrag = { change, amount -> change.consume(); dy += amount.y },
                                        onDragEnd = {
                                            val to = ModelRules.dropIndex(i, dy, rowHeight, order.size)
                                            dragging = -1; dy = 0f
                                            if (to != i) save(ModelRules.move(order, i, to))
                                        },
                                        onDragCancel = { dragging = -1; dy = 0f },
                                    )
                                }.testTag("fallback.$i.handle"),
                            )
                        }
                        Text("${i + 1}", fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
                        Text(label(ref, providers) ?: ref.model, fontSize = FontTokens.sizeSm.sp, modifier = Modifier.weight(1f))
                        if (isAdmin) HubIconButton(Lucide.X, stringResource(R.string.models_remove), { save(order.filterIndexed { j, _ -> j != i }) }, size = 28.dp, iconSize = 14.dp)
                    }
                }
                if (order.isEmpty()) Text(stringResource(R.string.models_no_fallbacks), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
            }
            if (isAdmin) HubButton(stringResource(R.string.models_add_fallback), { picking = "fallback" }, kind = ButtonKind.Subtle, size = ControlSize.Sm, icon = Lucide.Plus, modifier = Modifier.testTag("defaults.add_fallback"))
        }
        picking?.let { what ->
            ModelPickerSheet(
                stringResource(if (what == "default") R.string.models_default else R.string.models_add_fallback), chat, providers,
                onPick = { ref ->
                    picking = null
                    if (what == "default") scope.launch { ops.setDefault(ref).onFailure { error = it as HubError }; load.reload() }
                    else save(ModelRules.add(order, ref, d.default))
                },
                onDismiss = { picking = null },
            )
        }
    }
}

/** Speech: which provider listens and which speaks, and the voice — searched, every language, heard before it is kept. */
@Composable
private fun SpeechTab(ops: ModelOps, isAdmin: Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val load = rememberLoad(ops.profile, "speech") { ops.speech().getOrThrow() }
    var error by remember { mutableStateOf<HubError?>(null) }
    var choosing by remember { mutableStateOf<String?>(null) }
    var voicesOf by remember { mutableStateOf<SpeechProvider?>(null) }
    LoadView(load) { speech ->
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp).testTag("models.speech"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ErrorNotice(error)
            listOf("stt" to speech.stt, "tts" to speech.tts).forEach { (side, s) ->
                val active = s.providers.firstOrNull { it.id == s.activeProviderId }
                GroupedList(title = stringResource(if (side == "stt") R.string.models_stt else R.string.models_tts)) {
                    Custom {
                        Box {
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                                Column(Modifier.weight(1f)) {
                                    Text(active?.label ?: stringResource(R.string.models_none_chosen), fontSize = FontTokens.sizeMd.sp)
                                    if (!s.ready) Text(s.reason ?: stringResource(R.string.models_not_ready), fontSize = FontTokens.sizeXs.sp, color = t.warningSoftText)
                                }
                                Badge(stringResource(if (s.ready) R.string.models_ready else R.string.models_not_ready), tone = if (s.ready) BadgeTone.Success else BadgeTone.Warning, dot = true)
                                if (isAdmin && s.providers.size > 1) HubIconButton(Lucide.ChevronsUpDown, stringResource(R.string.models_change), { choosing = side }, size = 32.dp, iconSize = 16.dp, modifier = Modifier.testTag("speech.$side.change"))
                            }
                            HubMenu(choosing == side, { choosing = null }) {
                                s.providers.forEach { p ->
                                    MenuItem(p.label, {
                                        choosing = null
                                        scope.launch {
                                            (if (side == "stt") ops.useSpeech(stt = p.id) else ops.useSpeech(tts = p.id)).onFailure { error = it as HubError }
                                            load.reload()
                                        }
                                    }, checked = p.id == s.activeProviderId)
                                }
                            }
                        }
                    }
                    if (side == "tts" && active != null) {
                        Item(
                            stringResource(R.string.models_voice), value = active.settings.voice ?: "—", chevron = isAdmin, icon = Lucide.Volume2, tag = "speech.voice",
                            onClick = if (isAdmin) ({ voicesOf = active }) else null,
                        )
                    }
                }
            }
            if (speech.stt.providers.isEmpty() && speech.tts.providers.isEmpty()) {
                NoticeBox(stringResource(R.string.models_speech_none), BadgeTone.Info)
            }
        }
        voicesOf?.let { p -> VoicePicker(ops, p, onPicked = { voicesOf = null; load.reload() }, onDismiss = { voicesOf = null }) }
    }
}

@Composable
private fun VoicePicker(ops: ModelOps, provider: SpeechProvider, onPicked: () -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val voices = rememberLoad(provider.id, "voices") { ops.voices(provider.id, provider.settings.model).getOrThrow() }
    var query by remember { mutableStateOf("") }
    var playing by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<HubError?>(null) }
    val app = context.graph.prefs.effectiveLanguage
    val phone = androidx.compose.ui.platform.LocalConfiguration.current.locales[0].language
    val preferred = listOf(app.tag) + listOf(phone).filter { it != app.tag } + listOf("en")
    val fallbackSample = stringResource(R.string.models_voice_sample)
    val player = remember { android.media.MediaPlayer() }
    androidx.compose.runtime.DisposableEffect(Unit) { onDispose { runCatching { player.release() } } }
    HubSheet(onDismiss = onDismiss, title = stringResource(R.string.models_voice_of, provider.label)) {
        ErrorNotice(error)
        HubTextField(query, { query = it }, placeholder = stringResource(R.string.models_voice_search), leadingIcon = Lucide.Search, size = ControlSize.Md, fieldTag = "voice.search")
        LoadView(voices) { all ->
            val list = ModelRules.voices(all, preferred, query)
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
                GroupedList {
                    list.forEach { v ->
                        Item(
                            v.name, subtitle = listOfNotNull(v.language, v.description).joinToString(" · ").ifEmpty { null }, tag = "voice.${v.id}",
                            trailing = {
                                HubIconButton(if (playing == v.id) Lucide.CircleStop else Lucide.Play, stringResource(R.string.models_voice_preview), {
                                    playing = v.id
                                    scope.launch {
                                        ops.preview(provider.id, v.id, ModelRules.sample(v.language, fallbackSample), v.language)
                                            .onSuccess { file ->
                                                runCatching {
                                                    player.reset(); player.setDataSource(file.absolutePath); player.prepare(); player.start()
                                                    player.setOnCompletionListener { playing = null }
                                                }.onFailure { playing = null }
                                            }
                                            .onFailure { error = it as HubError; playing = null }
                                    }
                                }, size = 32.dp, iconSize = 16.dp, modifier = Modifier.testTag("voice.${v.id}.play"))
                            },
                            value = if (v.id == provider.settings.voice) "✓" else null,
                            onClick = { scope.launch { ops.setVoice(provider.id, v.id).onSuccess { onPicked() }.onFailure { error = it as HubError } } },
                        )
                    }
                }
                if (list.isEmpty()) Text(stringResource(R.string.models_voice_none), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
            }
        }
    }
}

/** Pictures: the model the agents draw with (a chat model is never offered here unless its provider draws, §87). */
@Composable
private fun ImagesTab(ops: ModelOps, providers: List<Provider>, isAdmin: Boolean) {
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val load = rememberLoad(ops.profile, "defaults-image") { ops.defaults().getOrThrow() }
    var picking by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<HubError?>(null) }
    val models = remember(providers) { ModelRules.imageModels(providers) }
    LoadView(load) { d ->
        Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp).testTag("models.images"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ErrorNotice(error)
            GroupedList(title = stringResource(R.string.models_image_model)) {
                Item(
                    label(d.image, providers) ?: stringResource(R.string.models_none_chosen), icon = Lucide.Image, chevron = isAdmin && models.isNotEmpty(),
                    tag = "images.model", onClick = if (isAdmin && models.isNotEmpty()) ({ picking = true }) else null,
                )
            }
            if (models.isEmpty()) NoticeBox(stringResource(R.string.models_images_none), BadgeTone.Info)
            else Text(stringResource(R.string.models_images_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
        }
        if (picking) ModelPickerSheet(stringResource(R.string.models_image_model), models, providers, onPick = { ref ->
            picking = false
            scope.launch { ops.setImage(ref).onFailure { error = it as HubError }; load.reload() }
        }, onDismiss = { picking = false })
    }
}
