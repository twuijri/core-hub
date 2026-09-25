// «This device» (destination `this_device`): voice input, the dictation language and spoken
// replies are this phone's own choices, kept on the phone (proposed — owner to confirm), because
// another device of the same person may have no microphone or a different language.
//
// Where the voice comes from (owner, 2026-09-25), as on the web: the hub's speech providers of
// the chat's profile when it has them (`models.transcribe`, `models.synthesize`), else this
// phone's own recognizer and voice. «Voice: Core Hub / This phone» chooses; Core Hub by default.
import AVFoundation
import CoreHubClient
import Foundation
import Observation
import Speech

@MainActor
@Observable
final class DeviceSettings {
    enum DictationLanguage: String, CaseIterable, Identifiable {
        /// The app's own language.
        case app
        case ar
        case en

        var id: String { rawValue }
    }

    /// Whose speech dictation and spoken replies use.
    enum VoiceSource: String, CaseIterable, Identifiable {
        /// The hub's STT / TTS providers, when the profile has them; the phone otherwise.
        case hub
        /// Always the phone's own recognizer and voice.
        case phone

        var id: String { rawValue }
    }

    var voiceInput: Bool { didSet { defaults.set(voiceInput, forKey: Keys.voiceInput) } }
    var dictationLanguage: DictationLanguage { didSet { defaults.set(dictationLanguage.rawValue, forKey: Keys.dictation) } }
    var spokenReplies: Bool { didSet { defaults.set(spokenReplies, forKey: Keys.spoken) } }
    var voiceSource: VoiceSource { didSet { defaults.set(voiceSource.rawValue, forKey: Keys.voiceSource) } }
    /// Look for the hub's notices now and then while the app is closed.
    var backgroundChecks: Bool { didSet { defaults.set(backgroundChecks, forKey: Keys.background) } }

    @ObservationIgnored private let defaults: UserDefaults

    enum Keys {
        static let voiceInput = Product.storagePrefix + "device.voice_input"
        static let dictation = Product.storagePrefix + "device.dictation_language"
        static let spoken = Product.storagePrefix + "device.spoken_replies"
        static let voiceSource = Product.storagePrefix + "device.voice_source"
        static let background = Product.storagePrefix + "device.background_checks"
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        voiceInput = defaults.object(forKey: Keys.voiceInput) as? Bool ?? true
        dictationLanguage = defaults.string(forKey: Keys.dictation).flatMap(DictationLanguage.init(rawValue:)) ?? .app
        spokenReplies = defaults.bool(forKey: Keys.spoken)
        voiceSource = defaults.string(forKey: Keys.voiceSource).flatMap(VoiceSource.init(rawValue:)) ?? .hub
        backgroundChecks = defaults.object(forKey: Keys.background) as? Bool ?? true
    }

    /// The locale dictation listens in.
    func dictationLocale(app language: AppLanguage) -> Locale {
        switch dictationLanguage {
        case .app: return Voice.locale(for: language.rawValue)
        case .ar: return Voice.locale(for: "ar")
        case .en: return Voice.locale(for: "en")
        }
    }
}

enum Voice {
    static func locale(for language: String) -> Locale {
        Locale(identifier: language == "ar" ? "ar-SA" : "en-US")
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
        let language = ContentDirection.of(text) == .rightToLeft ? "ar" : "en"
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
                        speechRequest: SpeechRequest(text: part, language: language),
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

/// Dictation into the composer: a recording the hub transcribes (`models.transcribe`) when the
/// hub listens for this profile, else the phone's own speech recognition.
@MainActor
@Observable
final class Dictation {
    enum State: Equatable {
        case idle
        case listening
        /// The recording is with the hub.
        case transcribing
        case failed(String)
    }

    /// Sends a recording to the hub; its words back.
    typealias Transcribe = (_ audio: URL, _ durationMs: Int) async throws -> String

    private(set) var state: State = .idle
    /// What has been heard so far in this take.
    private(set) var heard = ""

    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var transcribe: Transcribe?
    @ObservationIgnored private var l10n = L10n(.en)
    @ObservationIgnored private var startedAt = Date()

    /// Listens in `locale`: into a recording for `hub` when it is given, else with the phone.
    func start(locale: Locale, l10n: L10n, hub: Transcribe? = nil) async {
        guard state != .listening, state != .transcribing else { return }
        self.l10n = l10n
        if let hub {
            await record(for: hub, l10n: l10n)
            return
        }
        let speech = await withCheckedContinuation { (continuation: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else {
            state = .failed(l10n("voice.denied"))
            return
        }
        let microphone = await AVAudioApplication.requestRecordPermission()
        guard microphone else {
            state = .failed(l10n("voice.denied"))
            return
        }
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            state = .failed(l10n("voice.unavailable"))
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            self.request = request
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            engine.prepare()
            try engine.start()
            heard = ""
            state = .listening
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                let text = result?.bestTranscription.formattedString
                let final = result?.isFinal ?? false
                Task { @MainActor in
                    guard let self else { return }
                    if let text { self.heard = text }
                    if error != nil || final { self.stop() }
                }
            }
        } catch {
            state = .failed(l10n("voice.unavailable"))
            stop()
        }
    }

    /// Records to a file (AAC, 16 kHz mono: small, and the hub takes m4a) until `stop()`.
    private func record(for hub: @escaping Transcribe, l10n: L10n) async {
        guard await AVAudioApplication.requestRecordPermission() else {
            state = .failed(l10n("voice.denied"))
            return
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let recorder = try AVAudioRecorder(url: file, settings: settings)
            guard recorder.record() else { throw CocoaError(.fileWriteUnknown) }
            self.recorder = recorder
            transcribe = hub
            startedAt = Date()
            heard = ""
            state = .listening
        } catch {
            state = .failed(l10n("voice.unavailable"))
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    /// Ends the take: the phone's recognizer stops; a recording goes to the hub for its words.
    func stop() {
        if let recorder {
            finishRecording(recorder)
            return
        }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        if state == .listening { state = .idle }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func finishRecording(_ recorder: AVAudioRecorder) {
        recorder.stop()
        self.recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard let transcribe else { state = .idle; return }
        self.transcribe = nil
        let file = recorder.url
        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        state = .transcribing
        Task {
            defer { try? FileManager.default.removeItem(at: file) }
            do {
                let text = try await transcribe(file, durationMs)
                heard = text
                state = .idle
            } catch {
                state = .failed(Dictation.describe(error, l10n: l10n))
            }
        }
    }

    /// A silent take is a hint, not an error (`400` with `details.reason: no_speech`).
    static func describe(_ error: Error, l10n: L10n) -> String {
        let failure = HubFailure(error)
        if failure.status == 400, failure.reason == "no_speech" { return l10n("voice.no_speech") }
        return failure.describe(l10n)
    }
}
