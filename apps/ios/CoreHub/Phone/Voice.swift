// «This device» (destination `this_device`): voice input, the dictation language and spoken
// replies are this phone's own choices, kept on the phone (proposed — owner to confirm), because
// another device of the same person may have no microphone or a different language.
//
// Where the voice comes from (owner, 2026-09-25), as on the web: the hub's speech providers of
// the chat's profile when it has them (`models.transcribe`, `models.synthesize`), else this
// phone's own recognizer and voice. «Voice: Core Hub / This phone» chooses; This phone by default
// (owner, 2026-09-26: «خل الأساسي حق الجوال ويقدر يغير المستخدم»).
import AVFoundation
import CoreHubClient
import Foundation
import Observation
import Speech

@MainActor
@Observable
final class DeviceSettings {
    /// How a photo from the library or the camera is sent (Telegram's choice).
    enum PhotoQuality: String, CaseIterable, Identifiable {
        /// ≤ 2048 px, JPEG 0.8, as an image.
        case compressed
        /// The untouched file, as a file.
        case original

        var id: String { rawValue }
    }

    /// Whose speech dictation and spoken replies use.
    enum VoiceSource: String, CaseIterable, Identifiable {
        /// The hub's STT / TTS providers, when the profile has them; the phone otherwise.
        case hub
        /// Always the phone's own recognizer and voice — the default (owner, 2026-09-26).
        case phone

        var id: String { rawValue }
    }

    var voiceInput: Bool { didSet { defaults.set(voiceInput, forKey: Keys.voiceInput) } }
    /// `DictationLanguage.auto` (the default: the keyboard in use picks it), or a BCP-47 tag
    /// the person chose from the microphone's menu or here.
    var dictationLanguage: String { didSet { defaults.set(dictationLanguage, forKey: Keys.dictation) } }
    var spokenReplies: Bool { didSet { defaults.set(spokenReplies, forKey: Keys.spoken) } }
    /// Written only when the person picks it (`didSet` does not run in `init`), so an install
    /// that never chose takes whatever the default is now.
    var voiceSource: VoiceSource { didSet { defaults.set(voiceSource.rawValue, forKey: Keys.voiceSource) } }
    var photoQuality: PhotoQuality { didSet { defaults.set(photoQuality.rawValue, forKey: Keys.photoQuality) } }
    /// Look for the hub's notices now and then while the app is closed.
    var backgroundChecks: Bool { didSet { defaults.set(backgroundChecks, forKey: Keys.background) } }

    @ObservationIgnored private let defaults: UserDefaults

    enum Keys {
        static let voiceInput = Product.storagePrefix + "device.voice_input"
        static let dictation = Product.storagePrefix + "device.dictation_language"
        static let spoken = Product.storagePrefix + "device.spoken_replies"
        static let voiceSource = Product.storagePrefix + "device.voice_source"
        static let photoQuality = Product.storagePrefix + "device.photo_quality"
        static let background = Product.storagePrefix + "device.background_checks"
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        voiceInput = defaults.object(forKey: Keys.voiceInput) as? Bool ?? true
        dictationLanguage = Self.dictation(defaults.string(forKey: Keys.dictation))
        spokenReplies = defaults.bool(forKey: Keys.spoken)
        voiceSource = defaults.string(forKey: Keys.voiceSource).flatMap(VoiceSource.init(rawValue:)) ?? .phone
        photoQuality = defaults.string(forKey: Keys.photoQuality).flatMap(PhotoQuality.init(rawValue:)) ?? .compressed
        backgroundChecks = defaults.object(forKey: Keys.background) as? Bool ?? true
    }

    /// A stored dictation choice as it reads now. Up to 1.1.x the choices were `app` (the app's
    /// language — what made an English app hear Arabic as English), `ar` and `en`: `app`
    /// becomes Auto, the others stay chosen.
    static func dictation(_ stored: String?) -> String {
        guard let stored, stored != "app", stored != DictationLanguage.auto,
              let tag = DictationLanguage.tag(stored) else { return DictationLanguage.auto }
        return tag
    }

    /// The language to send the hub with a recording: none with Auto, so its speech-to-text
    /// model detects it (`models.transcribe` `language` is a hint; a wrong one would force it),
    /// else the chosen one.
    var hubDictationLanguage: String? {
        dictationLanguage == DictationLanguage.auto ? nil : DictationLanguage.base(dictationLanguage)
    }
}

enum Voice {
    /// The audio the iPhone asks the hub to speak in (`SpeechRequest.format`, DECISIONS §87):
    /// `AVAudioPlayer` plays MP3, not Ogg.
    static let hubFormat = SpeechFormat.mp3

    /// The phone's voice for a reply: the language it is written in (DictationLanguage.script),
    /// in the phone's own variant of it when the phone has one.
    static func locale(for language: String) -> Locale {
        let preferred = Locale.preferredLanguages.first { DictationLanguage.base($0) == DictationLanguage.base(language) }
        return Locale(identifier: preferred ?? language)
    }

    /// The language a reply is written in, by its script, as the phone knows it (its own
    /// languages first); English when it cannot tell.
    static func language(of text: String) -> String {
        guard let script = DictationLanguage.script(of: [text]) else { return "en" }
        return DictationLanguage.base(DictationLanguage.language(for: script, known: Locale.preferredLanguages))
    }

    /// A reply in parts the hub speaks (`SpeechRequest.text` ≤ 2 000): cut at a sentence or a
    /// line when one is near the limit, else at a space, never inside a word when it can help it.
    static func chunks(_ text: String, limit: Int = 2000) -> [String] {
        var parts: [String] = []
        var rest = Substring(text)
        while rest.count > limit {
            let window = rest.prefix(limit)
            let cut = window.lastIndex(where: { ".!?؟\n".contains($0) }).map { window.index(after: $0) }
                ?? window.lastIndex(of: " ").map { window.index(after: $0) }
                ?? window.endIndex
            let part = rest[rest.startIndex..<cut].trimmingCharacters(in: .whitespacesAndNewlines)
            if !part.isEmpty { parts.append(part) }
            rest = rest[cut...]
        }
        let last = rest.trimmingCharacters(in: .whitespacesAndNewlines)
        if !last.isEmpty { parts.append(last) }
        return parts
    }

    /// What a reply sounds like read aloud: its words, without Markdown's marks or code.
    static func speakable(_ markdown: String) -> String {
        var lines: [String] = []
        var inFence = false
        for line in markdown.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                inFence.toggle()
                continue
            }
            if inFence { continue }
            lines.append(line)
        }
        let joined = lines.joined(separator: "\n")
        let plain = String(MarkdownParser.inline(joined).characters)
        return plain
            .replacingOccurrences(of: "#", with: "")
            .replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Which side speaks or listens: the rule, apart from the audio, so it is tested.
enum VoiceRoute: Equatable {
    case hub
    case phone

    /// The hub when the person chose Core Hub and the profile's provider is ready; the phone
    /// otherwise — including when the hub could not be asked (`hubReady` nil).
    static func choose(_ source: DeviceSettings.VoiceSource, hubReady: Bool?) -> VoiceRoute {
        source == .hub && hubReady == true ? .hub : .phone
    }
}

/// Whether the hub can listen and speak for a profile (`models.getSpeech`), asked at most once
/// a minute per profile.
@MainActor
final class HubSpeech {
    static let shared = HubSpeech()

    struct Ready: Equatable {
        var stt: Bool
        var tts: Bool
    }

    private var known: [String: (ready: Ready, at: Date)] = [:]

    /// nil when the hub could not say (offline, an older hub): the phone is used then.
    func ready(app: AppModel, profile: String) async -> Ready? {
        if let cached = known[profile], Date().timeIntervalSince(cached.at) < 60 { return cached.ready }
        guard let settings = try? await app.api.call({
            try await ModelsAPI.modelsGetSpeech(xHubProfile: profile, apiConfiguration: $0)
        }) else { return nil }
        let ready = Ready(stt: settings.stt.ready, tts: settings.tts.ready)
        known[profile] = (ready, Date())
        return ready
    }

    func forget() { known.removeAll() }
}

/// Reads finished replies aloud when «Spoken replies» is on: with the hub's voice when it has
/// one (and the person chose Core Hub), else the phone's.
@MainActor
final class Speaker {
    static let shared = Speaker()
    private let synthesizer = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private var playing: Task<Void, Never>?

    func speak(_ markdown: String, app: AppModel? = nil, profile: String? = nil) {
        let text = Voice.speakable(markdown)
        guard !text.isEmpty else { return }
        stop()
        // The reply's own language, by its letters: Arabic, Russian, Hindi… not only Arabic or English.
        let language = Voice.language(of: text)
        guard let app, let profile, app.device.voiceSource == .hub else {
            speakOnPhone(text, language: language)
            return
        }
        playing = Task { [weak self] in
            let ready = await HubSpeech.shared.ready(app: app, profile: profile)
            guard let self, !Task.isCancelled else { return }
            guard VoiceRoute.choose(app.device.voiceSource, hubReady: ready?.tts) == .hub else {
                self.speakOnPhone(text, language: language)
                return
            }
            // The hub takes up to 2 000 characters a request: longer replies go in parts.
            for (index, part) in Voice.chunks(text).enumerated() {
                let file = try? await app.api.call {
                    try await ModelsAPI.modelsSynthesize(
                        xHubProfile: profile,
                        // MP3: the iPhone cannot play the Ogg some providers send by default (§87).
                        speechRequest: SpeechRequest(text: part, language: language, format: Voice.hubFormat),
                        apiConfiguration: $0
                    )
                }
                guard !Task.isCancelled else { return }
                // `AVAudioPlayer(data:)` finds the format itself (mp3, wav or ogg, as the hub sends).
                let audio = file.flatMap { try? Data(contentsOf: $0) }
                if let file { try? FileManager.default.removeItem(at: file) }
                guard let audio, let player = try? AVAudioPlayer(data: audio) else {
                    // The hub could not speak this time: the phone reads what is left.
                    if index == 0 { self.speakOnPhone(text, language: language) }
                    return
                }
                self.player = player
                try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
                player.play()
                while player.isPlaying, !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
            }
        }
    }

    private func speakOnPhone(_ text: String, language: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: Voice.locale(for: language).identifier)
        synthesizer.speak(utterance)
    }

    func stop() {
        playing?.cancel()
        playing = nil
        player?.stop()
        player = nil
        synthesizer.stopSpeaking(at: .immediate)
    }
}

