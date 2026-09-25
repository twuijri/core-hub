// «This device» (destination `this_device`): voice input, the dictation language and spoken
// replies are this phone's own choices, kept on the phone (proposed — owner to confirm), because
// another device of the same person may have no microphone or a different language.
import AVFoundation
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

    var voiceInput: Bool { didSet { defaults.set(voiceInput, forKey: Keys.voiceInput) } }
    var dictationLanguage: DictationLanguage { didSet { defaults.set(dictationLanguage.rawValue, forKey: Keys.dictation) } }
    var spokenReplies: Bool { didSet { defaults.set(spokenReplies, forKey: Keys.spoken) } }

    @ObservationIgnored private let defaults: UserDefaults

    enum Keys {
        static let voiceInput = Product.storagePrefix + "device.voice_input"
        static let dictation = Product.storagePrefix + "device.dictation_language"
        static let spoken = Product.storagePrefix + "device.spoken_replies"
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        voiceInput = defaults.object(forKey: Keys.voiceInput) as? Bool ?? true
        dictationLanguage = defaults.string(forKey: Keys.dictation).flatMap(DictationLanguage.init(rawValue:)) ?? .app
        spokenReplies = defaults.bool(forKey: Keys.spoken)
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

/// Reads finished replies aloud when «Spoken replies» is on.
@MainActor
final class Speaker {
    static let shared = Speaker()
    private let synthesizer = AVSpeechSynthesizer()

    func speak(_ markdown: String) {
        let text = Voice.speakable(markdown)
        guard !text.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: text)
        let language = ContentDirection.of(text) == .rightToLeft ? "ar" : "en"
        utterance.voice = AVSpeechSynthesisVoice(language: Voice.locale(for: language).identifier)
        synthesizer.stopSpeaking(at: .immediate)
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }
}

/// Dictation into the composer with the phone's own speech recognition.
@MainActor
@Observable
final class Dictation {
    enum State: Equatable {
        case idle
        case listening
        case failed(String)
    }

    private(set) var state: State = .idle
    /// What has been heard so far in this take.
    private(set) var heard = ""

    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?

    /// Asks for the microphone and speech recognition, then listens in `locale`.
    func start(locale: Locale, l10n: L10n) async {
        guard state != .listening else { return }
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

    func stop() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        if state == .listening { state = .idle }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
