import Combine
import Foundation

/// Server text-to-speech for the spoken reply, mirroring the web client.
///
/// The web never lets Studio guess: `useVoiceSettings.ts` loads
/// `GET /api/studio/tts/settings` (`settings` + `activeProvider`) and
/// `useSpeech.ts` posts `provider` plus that provider's stored options to
/// `POST /api/studio/tts/synthesize`. A request without `provider` makes the
/// server resolve one itself, and its fallback is `edge` (Microsoft's free
/// voice) whenever the profile has no stored active provider — which is why
/// the phone spoke with a different voice than the browser.
///
/// Everything here except `VoiceOutputStore` is pure and unit-tested in
/// `HermesStudioTests/VoiceOutputTests.swift`.

// MARK: - Provider catalog

enum TtsProviderCatalog {
    /// The server's stored provider list
    /// (`packages/server/src/modules/studio/repositories/tts-settings-store.ts`).
    static let all = [
        "custom", "deepinfra", "doubao", "edge", "elevenlabs", "gemini",
        "groq", "mimo", "minimax", "mistral", "openai", "xai",
    ]

    static func isKnown(_ provider: String) -> Bool { all.contains(provider) }

    /// Product names, kept identical to the server's `PROVIDER_LABELS` so the
    /// phone, the web and the server logs name the same thing.
    static func label(_ provider: String) -> String {
        switch provider {
        case "openai": "OpenAI TTS"
        case "custom": "Custom TTS"
        case "edge": "Edge TTS"
        case "mimo": "MiMo TTS"
        case "doubao": "Doubao TTS"
        case "elevenlabs": "ElevenLabs TTS"
        case "gemini": "Gemini TTS"
        case "xai": "xAI TTS"
        case "mistral": "Mistral TTS"
        case "minimax": "MiniMax TTS"
        case "deepinfra": "DeepInfra TTS"
        case "groq": "Groq TTS"
        default: provider
        }
    }
}

// MARK: - `GET /api/studio/tts/settings`

/// One configured provider row. Secrets never leave the server: `apiKey`
/// comes back as the marker `[stored]`, which is recorded as a flag and never
/// echoed into a synthesis request.
struct TtsProviderSetting: Equatable, Identifiable {
    let provider: String
    /// String settings only (`baseUrl`, `model`, `voice`, `rate`, `pitch`, …).
    let options: [String: String]
    let baseUrlPresets: [String]
    let hasStoredKey: Bool

    var id: String { provider }

    init(provider: String, options: [String: String] = [:], baseUrlPresets: [String] = [], hasStoredKey: Bool = false) {
        self.provider = provider
        self.options = options
        self.baseUrlPresets = baseUrlPresets
        self.hasStoredKey = hasStoredKey
    }

    init(_ json: JSON) {
        let settings = json.object("settings")
        provider = json.string("provider")
        options = settings.reduce(into: [String: String]()) { result, entry in
            guard let value = entry.value as? String else { return }
            result[entry.key] = value
        }
        baseUrlPresets = settings.strings("baseUrlPresets")
        hasStoredKey = !json.object("secrets").string("apiKey").isEmpty
    }

    /// Short "voice · model" line for the settings list.
    var detail: String {
        [options["voice"], options["model"]]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty }
            .joined(separator: " · ")
    }
}

struct TtsSettings: Equatable {
    var providers: [TtsProviderSetting]
    /// The profile's active provider as the server reports it; `nil` when the
    /// field is absent or JSON `null`.
    var activeProvider: String?

    init(providers: [TtsProviderSetting] = [], activeProvider: String? = nil) {
        self.providers = providers
        self.activeProvider = activeProvider
    }

    init(_ json: JSON) {
        // The server answers `{ settings, activeProvider }`; the web's
        // normaliser also accepts `providers`, so both keys are read here.
        let rows = json.objects("providers").isEmpty ? json.objects("settings") : json.objects("providers")
        providers = rows.map { TtsProviderSetting($0) }.filter { TtsProviderCatalog.isKnown($0.provider) }
        // `JSONSerialization` decodes JSON `null` as `NSNull`, never `nil`, so
        // the value has to go through `value(_:)` which skips it.
        let raw = (json.value("activeProvider", "active_provider") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        activeProvider = TtsProviderCatalog.isKnown(raw) ? raw : nil
    }

    func setting(for provider: String) -> TtsProviderSetting? { providers.first { $0.provider == provider } }

    /// Rows for the settings picker: every configured provider plus the
    /// server's active one when it has no stored row yet (the server resolves
    /// to `edge` in that case, and the owner has to be able to see it).
    var selectableProviders: [String] {
        var ids = providers.map(\.provider)
        if let activeProvider, !ids.contains(activeProvider) { ids.append(activeProvider) }
        return ids
    }
}

// MARK: - `POST /api/studio/tts/synthesize`

enum TtsRequest {
    /// Never sent back to the server: the API key stays server-side (the
    /// settings endpoint only reports that one exists) and the base-URL
    /// presets are a UI history list, not a synthesis option.
    static let excludedOptionKeys: Set<String> = ["apiKey", "baseUrlPresets"]

    /// Options actually forwarded. Empty values are dropped because the
    /// server's `mergeStoredTtsOptions` treats a present-but-empty request
    /// option as an override of the stored one.
    static func options(_ stored: [String: String]) -> [String: String] {
        stored.filter { key, value in
            !excludedOptionKeys.contains(key) && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    static func body(text: String, provider: String?, options stored: [String: String]) -> JSON {
        var body: JSON = ["text": text, "options": options(stored)]
        if let provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines), !provider.isEmpty {
            body["provider"] = provider
        }
        return body
    }
}

/// Audio plus the provider and engine the server actually used
/// (`X-TTS-Provider` / `X-TTS-Engine`).
struct SynthesizedSpeech: Equatable {
    let audio: Data
    let provider: String
    let engine: String
}

/// A server voice that did not produce audio. Carries the status code, the
/// server's own error text and the provider that failed so the owner is told
/// what broke instead of silently hearing the iPhone voice.
struct TtsFailure: LocalizedError, Equatable {
    /// Provider the server reported, or the one the app asked for; empty when
    /// the server was left to resolve it.
    let provider: String
    /// HTTP status, or `0` when the request never reached a response.
    let status: Int
    let detail: String

    var errorDescription: String? { Self.message(provider: provider, status: status, detail: detail) }

    static func message(provider: String, status: Int, detail: String) -> String {
        let name = provider.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? String(localized: "the server voice")
            : TtsProviderCatalog.label(provider)
        let text = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        switch (status > 0, text.isEmpty) {
        case (true, false): return String(format: String(localized: "%1$@ failed (HTTP %2$lld): %3$@"), name, status, text)
        case (true, true): return String(format: String(localized: "%1$@ failed (HTTP %2$lld)"), name, status)
        case (false, false): return String(format: String(localized: "%1$@ failed: %2$@"), name, text)
        case (false, true): return String(format: String(localized: "%1$@ failed"), name)
        }
    }
}

enum TtsErrorBody {
    /// `{ error, detail }` from the Studio TTS controller; a plain-text body
    /// is trimmed and truncated instead.
    static func detail(_ data: Data) -> String {
        if let json = try? JSONSerialization.jsonObject(with: data) as? JSON {
            let error = json.string("error", "message")
            let detail = json.string("detail")
            if !error.isEmpty && !detail.isEmpty { return "\(error): \(detail)" }
            return detail.isEmpty ? error : detail
        }
        guard let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else { return "" }
        return text.count > 300 ? String(text.prefix(300)) + "…" : text
    }

    /// Studio and some providers answer a failure with a JSON body and HTTP
    /// 200. Handing that to `AVAudioPlayer` only fails later, with no reason
    /// to show, so the body is inspected before it is treated as audio.
    static func looksLikeJSON(contentType: String, data: Data) -> Bool {
        if contentType.lowercased().contains("json") { return true }
        guard let first = data.first(where: { $0 != 0x20 && $0 != 0x09 && $0 != 0x0a && $0 != 0x0d }) else { return false }
        return first == UInt8(ascii: "{") || first == UInt8(ascii: "[")
    }
}

// MARK: - Which voice speaks the reply

enum VoiceOutputChoice: Equatable {
    /// The iPhone voice (`AVSpeechSynthesizer`). Never calls the server.
    case device
    /// A named Studio provider, sent as `provider` on every synthesize call.
    case server(String)
    /// Nothing chosen yet and the profile's settings are not loaded: the
    /// request goes out without `provider` and Studio resolves it.
    case serverDefault

    var provider: String? {
        switch self {
        case .device, .serverDefault: return nil
        case let .server(id): return id
        }
    }
}

/// What a pick writes: the value stored for the profile on this device, and
/// the provider to send to `PUT /api/studio/tts/settings/active` — which is
/// only ever written when the owner explicitly picks a different server
/// provider, never as a side effect of speaking or of choosing the device voice.
struct VoiceOutputPlan: Equatable {
    let stored: String
    let activeProviderWrite: String?
}

enum VoiceOutputSelection {
    static let devicePreference = "device"

    static func choice(stored: String, serverActive: String?) -> VoiceOutputChoice {
        let value = stored.trimmingCharacters(in: .whitespacesAndNewlines)
        if value == devicePreference { return .device }
        if TtsProviderCatalog.isKnown(value) { return .server(value) }
        // Nothing stored (or a provider this build does not know): follow the
        // profile, exactly like the web does after `loadServerTtsSettings`.
        if let serverActive, TtsProviderCatalog.isKnown(serverActive) { return .server(serverActive) }
        return .serverDefault
    }

    static func plan(for choice: VoiceOutputChoice, serverActive: String?) -> VoiceOutputPlan {
        switch choice {
        case .device:
            return VoiceOutputPlan(stored: devicePreference, activeProviderWrite: nil)
        case .serverDefault:
            return VoiceOutputPlan(stored: "", activeProviderWrite: nil)
        case let .server(id):
            return VoiceOutputPlan(stored: id, activeProviderWrite: id == serverActive ? nil : id)
        }
    }
}

enum VoiceFallbackNotice {
    static func message(for error: Error) -> String {
        String(format: String(localized: "Server voice unavailable (%@); the device voice was used instead."),
               error.localizedDescription)
    }
}

// MARK: - Loader

/// Per-profile TTS settings cache shared by the chat and the settings screen,
/// like `useVoiceSettings`'s module-level state in the web client.
@MainActor
final class VoiceOutputStore: ObservableObject {
    static let shared = VoiceOutputStore()

    @Published private(set) var loaded: [String: TtsSettings] = [:]
    @Published private(set) var errors: [String: String] = [:]
    /// Bumped after a pick is persisted so views re-read `Preferences`.
    @Published private(set) var revision = 0

    private var inFlight: [String: Task<TtsSettings?, Never>] = [:]

    private init() {}

    func settings(for profile: String) -> TtsSettings { loaded[profile] ?? TtsSettings() }
    func loadError(for profile: String) -> String? { errors[profile] }
    func isLoaded(_ profile: String) -> Bool { loaded[profile] != nil }

    func choice(for profile: String) -> VoiceOutputChoice {
        VoiceOutputSelection.choice(stored: Preferences.ttsVoice(for: profile),
                                    serverActive: loaded[profile]?.activeProvider)
    }

    @discardableResult
    func load(profile: String, api: APIClient, force: Bool = false) async -> TtsSettings? {
        if !force, let cached = loaded[profile] { return cached }
        if let running = inFlight[profile] { return await running.value }
        let task = Task<TtsSettings?, Never> { [weak self] in
            guard let self else { return nil }
            do {
                let settings = try await api.ttsSettings(profile: profile)
                self.loaded[profile] = settings
                self.errors[profile] = nil
                return settings
            } catch {
                self.errors[profile] = error.localizedDescription
                return nil
            }
        }
        inFlight[profile] = task
        let result = await task.value
        inFlight[profile] = nil
        return result
    }

    /// Provider and stored options for one synthesize call.
    func synthesize(text: String, profile: String, api: APIClient) async throws -> Data {
        let settings = await load(profile: profile, api: api) ?? self.settings(for: profile)
        let choice = VoiceOutputSelection.choice(stored: Preferences.ttsVoice(for: profile),
                                                 serverActive: settings.activeProvider)
        let provider = choice.provider
        let options = provider.flatMap { settings.setting(for: $0)?.options } ?? [:]
        return try await api.synthesize(text: text, provider: provider, options: options, profile: profile).audio
    }

    /// Persists the owner's pick. A server provider is also written to the
    /// profile (`PUT …/settings/active`) so the web and the phone agree —
    /// but only when it actually differs from what the server already has.
    func select(_ choice: VoiceOutputChoice, profile: String, api: APIClient) async throws {
        let plan = VoiceOutputSelection.plan(for: choice, serverActive: settings(for: profile).activeProvider)
        if let write = plan.activeProviderWrite {
            let saved = try await api.setActiveTtsProvider(write, profile: profile)
            var current = settings(for: profile)
            current.activeProvider = saved.isEmpty ? write : saved
            loaded[profile] = current
        }
        Preferences.setTtsVoice(plan.stored, profile: profile)
        revision += 1
    }
}
