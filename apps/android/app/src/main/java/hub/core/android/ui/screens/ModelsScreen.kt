package hub.core.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.data.HubApis
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.generated.FontTokens
import hub.core.android.graph
import hub.core.android.ui.components.LoadView
import hub.core.android.ui.components.rememberLoad
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.Segment
import hub.core.android.ui.kit.Segmented
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Model
import hub.core.client.model.ModelCapability
import hub.core.client.model.ModelDefaults
import hub.core.client.model.ModelDefaultsWrite
import hub.core.client.model.ModelDefaultsWriteAssignmentsValue
import hub.core.client.model.ModelKind
import hub.core.client.model.ModelPatch
import hub.core.client.model.ModelRef
import hub.core.client.model.Provider
import hub.core.client.model.ProviderAllOfAuth
import hub.core.client.model.ProviderAllOfCatalogue
import hub.core.client.model.ProviderCreate
import hub.core.client.model.ProviderHost
import hub.core.client.model.ProviderKind
import hub.core.client.model.ProviderPatch
import hub.core.client.model.ProviderPreset
import hub.core.client.model.ProviderScope
import hub.core.client.model.ProviderSignIn
import hub.core.client.model.SpeechFormat
import hub.core.client.model.SpeechRequest
import hub.core.client.model.SpeechSettingsPatch
import hub.core.client.model.SpeechSettingsPatchProvidersInner
import hub.core.client.model.Voice
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.roundToInt

/** Models on the phone (owner: native, not «open the web»), as the web's page: the rules, apart from the screens. */
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
    fun ready(preset: ProviderPreset, key: String, baseUrl: String, scope: ProviderScope = ProviderScope.ALL): Boolean =
        (preset.signIn || keyOptional(preset, scope) || key.isNotBlank()) && (!preset.baseUrlRequired || baseUrl.isNotBlank())

    /** The key can be left out: the preset does not demand one, or its account has one saved in [scope] (§94). */
    fun keyOptional(preset: ProviderPreset, scope: ProviderScope): Boolean =
        preset.key == ProviderPreset.Key.OPTIONAL || keyOnFile(preset, scope)

    fun keyOnFile(preset: ProviderPreset, scope: ProviderScope): Boolean =
        preset.keyOnFile.orEmpty().any { it.value == scope.value }

    /** The presets that can still be added in [scope]: a repeatable one always, another once per scope (a second is `409`). */
    fun offered(presets: List<ProviderPreset>, added: List<Provider>, scope: ProviderScope): List<ProviderPreset> {
        val taken = added.filter { it.scope == scope }.map { it.slug }.toSet()
        return presets.filter { it.repeatable || it.id !in taken }
    }

    /** A bare OpenAI-compatible endpoint (the web's "Custom"): a name and an address; a key only when typed. */
    fun custom(label: String, kind: ProviderKind, baseUrl: String, key: String, scope: ProviderScope): ProviderCreate? {
        val l = label.trim()
        val u = baseUrl.trim()
        if (l.isEmpty() || u.isEmpty()) return null
        return ProviderCreate(label = l, kind = kind, baseUrl = u, apiKey = key.trim().takeIf { it.isNotEmpty() }, apiMode = ProviderCreate.ApiMode.CHAT_COMPLETIONS, scope = scope)
    }

    /**
     * What editing a provider sends: what changed; an emptied address is cleared; the key only when a
     * new one was typed — an empty field means "leave it", never "remove it".
     */
    fun edit(provider: Provider, label: String, baseUrl: String, key: String, enabled: Boolean): ProviderPatch {
        val l = label.trim()
        val u = baseUrl.trim()
        val k = key.trim()
        return ProviderPatch(
            label = l.takeIf { it.isNotEmpty() && it != provider.label },
            enabled = enabled.takeIf { it != provider.enabled },
            apiKey = k.takeIf { it.isNotEmpty() },
            baseUrl = u.takeIf { it.isNotEmpty() && it != provider.baseUrl },
            sendNull = if (u.isEmpty() && provider.baseUrl != null) setOf(ProviderPatch.Clearable.BASE_URL) else emptySet(),
        )
    }

    /** A display name: typed text sets it, an empty field goes back to the provider's own id. */
    fun alias(text: String): ModelPatch =
        text.trim().let { if (it.isEmpty()) ModelPatch(sendNull = setOf(ModelPatch.Clearable.ALIAS)) else ModelPatch(alias = it) }

    /**
     * A model id as the `{model}` of `models.putModel`, encoded once here as the web does, so an id with
     * `/` (OpenRouter's `anthropic/claude-…`) stays one path segment after the client encodes it again
     * and the hub decodes it twice.
     */
    fun pathModel(model: String): String = buildString {
        model.toByteArray(Charsets.UTF_8).forEach { byte ->
            val c = byte.toInt().toChar()
            if (byte >= 0 && (c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c in "-._~")) append(c) else append("%%%02X".format(byte.toInt() and 0xFF))
        }
    }

    /** A chain saved on an inherited chat model saves that model too, so the chain has one of this profile's to fall back from. */
    fun fallbackWrite(fallbacks: List<ModelRef>, defaults: ModelDefaults?): ModelDefaultsWrite {
        val chat = defaults?.default
        return if (chat != null && defaults.inherited.orEmpty().contains("default")) ModelDefaultsWrite(default = chat, fallbacks = fallbacks)
        else ModelDefaultsWrite(fallbacks = fallbacks)
    }

    /** One auxiliary role set to [ref]. */
    fun assignment(key: String, ref: ModelRef): ModelDefaultsWrite =
        ModelDefaultsWrite(assignments = mapOf(key to ModelDefaultsWriteAssignmentsValue(ref.providerId, ref.model)))

    /** Where a provider's model list came from (§83), and whether it is being fetched or failed. */
    sealed interface CatalogueNote {
        data object Refreshing : CatalogueNote
        data class Failed(val error: String) : CatalogueNote
        data class Fallback(val reason: String?) : CatalogueNote
        data object FromAccount : CatalogueNote
    }

    fun catalogueNotes(p: Provider): List<CatalogueNote> = buildList {
        if (p.catalogue.status == ProviderAllOfCatalogue.Status.LOADING) add(CatalogueNote.Refreshing)
        p.catalogue.error?.takeIf { it.isNotBlank() }?.let { add(CatalogueNote.Failed(it)) }
        if (p.catalogue.source == ProviderAllOfCatalogue.Source.FALLBACK) add(CatalogueNote.Fallback(p.catalogue.fallbackReason))
        else if (p.auth.kind == ProviderAllOfAuth.Kind.OAUTH && p.catalogue.source == ProviderAllOfCatalogue.Source.PROVIDER) add(CatalogueNote.FromAccount)
    }

    /** The same address with the container's host alias, when a loopback address would reach the hub's own container. */
    fun loopbackSuggestion(url: String, host: ProviderHost?): String? {
        if (host == null || !host.containerized) return null
        val uri = runCatching { java.net.URI(url.trim()) }.getOrNull() ?: return null
        val name = uri.host?.lowercase()?.removePrefix("[")?.removeSuffix("]") ?: return null
        if (name !in setOf("localhost", "127.0.0.1", "0.0.0.0", "::1")) return null
        return runCatching { java.net.URI(uri.scheme, uri.userInfo, host.loopbackAlias, uri.port, uri.path, uri.query, uri.fragment).toString() }
            .getOrNull()?.trimEnd('/')
    }

    /** A speech setting as the hub keeps it: empty is `null` (the provider's default, or "detect the language"). */
    fun speechSetting(text: String): JsonElement = text.trim().let { if (it.isEmpty()) JsonNull else JsonPrimitive(it) }

    /** The languages offered first for speech, as the web's list; any other code can be typed. */
    val popularLanguages = listOf("ar", "en", "es", "fr", "de", "zh", "hi", "pt", "ru", "ja", "ko", "it", "tr", "ur", "fa", "id")

    /** A language code a person typed: `ar`, `ar-EG`, `zh-Hant-TW`. */
    fun languageCode(text: String): Boolean = Regex("^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$").matches(text.trim())

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

    /** Models a chat can be held with: visible chat models of enabled chat providers, never one that only draws (§87). */
    fun chatModels(providers: List<Provider>): List<Model> =
        providers.filter { it.enabled && it.kind == ProviderKind.LLM }.flatMap { p -> p.models.filter { it.kind == ModelKind.CHAT && it.imageOnly != true && !it.disabled && it.visible } }

    /** The providers the hub can draw with (§72, §84): it says so, or — an older hub — any chat provider not signed in to. */
    fun draws(p: Provider): Boolean = p.enabled && p.kind == ProviderKind.LLM && (p.drawsImages ?: (p.auth.kind != ProviderAllOfAuth.Kind.OAUTH))

    /** The Images tab's models: those that draw on a provider that draws, the ones that only draw first (§87, §110). */
    fun imageModels(providers: List<Provider>): List<Model> =
        providers.filter(::draws).flatMap { p -> p.models.filter { !it.disabled && it.visible && ModelCapability.IMAGE_OUTPUT in it.capabilities } }
            .sortedByDescending { it.imageOnly == true }

    /** A subscription's image model is not one the provider lists: its name says how it draws (§84). */
    fun viaSubscription(model: Model, providers: List<Provider>): String? {
        if (model.alias != null) return null
        val p = providers.firstOrNull { it.id == model.providerId } ?: return null
        return p.label.takeIf { p.auth.kind == ProviderAllOfAuth.Kind.OAUTH }
    }
}

/** What the Models page changes, against the profile the selector is on. */
class ModelOps(private val apis: () -> HubApis?, val profile: String) {
    private suspend fun <T> call(block: suspend (HubApis) -> T): Result<T> {
        val api = apis() ?: return Result.failure(HubError(401, "unauthorized", null))
        return hubCall { block(api) }
    }

    suspend fun providers() = call { it.models.modelsListProviders(profile).items }
    suspend fun presets() = call { it.models.modelsListProviderPresets(profile) }
    suspend fun create(body: ProviderCreate) = call { it.models.modelsCreateProvider(profile, body) }
    suspend fun update(p: Provider, patch: ProviderPatch) = call { it.models.modelsUpdateProvider(profile, p.id, patch) }
    suspend fun setEnabled(p: Provider, on: Boolean) = update(p, ProviderPatch(enabled = on))
    suspend fun setKey(p: Provider, key: String) = update(p, ProviderPatch(apiKey = key.trim()))
    suspend fun clearKey(p: Provider) = update(p, ProviderPatch(apiKey = ""))
    suspend fun delete(p: Provider) = call { it.models.modelsDeleteProvider(profile, p.id) }
    suspend fun test(p: Provider) = call { it.models.modelsTestProvider(profile, p.id) }
    suspend fun refresh(p: Provider) = call { it.models.modelsRefreshProvider(profile, p.id) }
    suspend fun setAlias(p: Provider, model: String, alias: String) =
        call { it.models.modelsPutModel(profile, p.id, ModelRules.pathModel(model), ModelRules.alias(alias)) }
    suspend fun probe(body: hub.core.client.model.ProviderProbe) = call { it.models.modelsProbeProvider(profile, body) }
    /** Registers a model the provider's catalogue has not listed yet, so it can be a default now. */
    suspend fun registerModel(p: Provider, model: String) =
        call { it.models.modelsPutModel(profile, p.id, ModelRules.pathModel(model), hub.core.client.model.ModelPatch(custom = true)) }
    suspend fun signIn(p: Provider) = call { it.models.modelsStartProviderSignIn(profile, p.id) }
    suspend fun signInState(providerId: String, id: String) = call { it.models.modelsGetProviderSignIn(profile, providerId, id) }
    /** The address a sign-in by link landed on, pasted back (DECISIONS §143). */
    suspend fun completeSignIn(providerId: String, id: String, code: String) =
        call { it.models.modelsCompleteProviderSignIn(profile, providerId, id, hub.core.client.model.ModelsCompleteProviderSignInRequest(code = code)) }
    /** A subscription's accounts through Core Hub's gateway, and «Check now» (§143). */
    suspend fun accounts(p: Provider) = call { it.models.modelsGetProviderAccounts(profile, p.id) }
    suspend fun checkAccount(p: Provider, id: String) = call { it.models.modelsCheckProviderAccount(profile, p.id, id) }
    suspend fun subscriptionVendors() = call { it.models.modelsListSubscriptionVendors(profile) }
    suspend fun defaults() = call { it.models.modelsGetDefaults(profile) }
    suspend fun writeDefaults(body: ModelDefaultsWrite) = call { it.models.modelsSetDefaults(profile, body) }
    suspend fun setDefault(ref: ModelRef?) =
        writeDefaults(if (ref != null) ModelDefaultsWrite(default = ref) else ModelDefaultsWrite(sendNull = setOf(ModelDefaultsWrite.Clearable.DEFAULT)))
    suspend fun setImage(ref: ModelRef?) =
        writeDefaults(if (ref != null) ModelDefaultsWrite(image = ref) else ModelDefaultsWrite(sendNull = setOf(ModelDefaultsWrite.Clearable.IMAGE)))
    suspend fun setFallbacks(list: List<ModelRef>, defaults: ModelDefaults? = null) = writeDefaults(ModelRules.fallbackWrite(list, defaults))
    suspend fun setAssignment(key: String, ref: ModelRef) = writeDefaults(ModelRules.assignment(key, ref))
    suspend fun speech() = call { it.models.modelsGetSpeech(profile) }
    suspend fun useSpeech(stt: String? = null, tts: String? = null) = call { it.models.modelsUpdateSpeech(profile, SpeechSettingsPatch(sttProviderId = stt, ttsProviderId = tts)) }

    /** One speech setting (`model`, `language`, `voice`) of one provider; empty is the provider's default. */
    suspend fun setSpeech(provider: String, key: String, value: String) = call {
        it.models.modelsUpdateSpeech(profile, SpeechSettingsPatch(providers = listOf(SpeechSettingsPatchProvidersInner(id = provider, settings = mapOf(key to ModelRules.speechSetting(value))))))
    }
    suspend fun setVoice(provider: String, voice: String) = setSpeech(provider, "voice", voice)
    suspend fun speechModels(provider: String, kind: ModelKind) = call { it.models.modelsListCatalogue(profile, kind = kind, providerId = provider, limit = 200).items }
    suspend fun voices(provider: String, model: String?) = call { it.models.modelsListVoices(profile, provider, model) }
    suspend fun preview(provider: String, voice: String, text: String, language: String?) =
        call { it.models.modelsSynthesize(profile, SpeechRequest(text = text, language = language, voice = voice, providerId = provider, format = SpeechFormat.MP3)) }
}

private enum class ModelsTab { PROVIDERS, DEFAULTS, SPEECH, IMAGES }

@Composable
private fun rememberModelOps(profile: String): ModelOps {
    val context = LocalContext.current
    return remember(profile) { ModelOps({ context.graph.store.current?.let(context.graph::apis) }, profile) }
}

/** Models, native on the phone: providers, defaults with the fallbacks in order and the auxiliary roles, speech and pictures. */
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
            ModelsTab.PROVIDERS -> ProvidersTab(ops, providers, isAdmin, profileName)
            ModelsTab.DEFAULTS -> LoadView(providers) { list -> DefaultsTab(ops, list, isAdmin) }
            ModelsTab.SPEECH -> SpeechTab(ops, isAdmin)
            ModelsTab.IMAGES -> LoadView(providers) { list -> ImagesTab(ops, list, isAdmin) }
        }
    }
}

@Composable
internal fun kindLabel(kind: ProviderKind): String = stringResource(
    when (kind) {
        ProviderKind.LLM -> R.string.models_kind_llm
        ProviderKind.STT -> R.string.models_kind_stt
        ProviderKind.TTS -> R.string.models_kind_tts
    },
)

/**
 * A model picker: the models given, by provider, searchable; [clear] (when given) is a first row that
 * clears the choice, and [name] says how a model is shown.
 */
@Composable
internal fun ModelPickerSheet(
    title: String,
    models: List<Model>,
    providers: List<Provider>,
    onPick: (ModelRef?) -> Unit,
    onDismiss: () -> Unit,
    clear: String? = null,
    name: (Model) -> String = { it.alias ?: it.model },
) {
    var query by remember { mutableStateOf("") }
    HubSheet(onDismiss = onDismiss, title = title) {
        HubTextField(query, { query = it }, placeholder = stringResource(R.string.search), leadingIcon = Lucide.Search, size = ControlSize.Md, fieldTag = "model.search")
        Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (clear != null) GroupedList { Item(clear, icon = Lucide.RotateCcw, tag = "model.clear", onClick = { onPick(null) }) }
            val q = query.trim()
            val shown = models.filter { q.isEmpty() || it.model.contains(q, true) || name(it).contains(q, true) }
            if (shown.isEmpty()) Text(stringResource(R.string.models_picker_none), fontSize = FontTokens.sizeSm.sp, color = LocalTokens.current.textMuted)
            shown.groupBy { it.providerId }.forEach { (providerId, list) ->
                GroupedList(title = providers.firstOrNull { it.id == providerId }?.label ?: list.first().provider) {
                    list.forEach { m ->
                        Item(name(m), subtitle = m.model.takeIf { it != name(m) }, tag = "model.${m.key}", onClick = { onPick(ModelRef(m.providerId, m.model)) })
                    }
                }
            }
        }
    }
}

internal fun modelLabel(ref: ModelRef?, providers: List<Provider>): String? = ref?.let { r ->
    val p = providers.firstOrNull { it.id == r.providerId }
    val alias = p?.models?.firstOrNull { it.model == r.model }?.alias
    "${alias ?: r.model} · ${p?.label ?: r.providerId}"
}

internal val modelsPage = SettingsPageEntry("models") { ModelsPage(it.session.profile, it.shell.profileName(it.session.profile), it.session.user.isAdmin) }
