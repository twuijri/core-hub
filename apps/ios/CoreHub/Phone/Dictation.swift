// Dictation into the composer: a recording the hub transcribes (`models.transcribe`) when the
// hub listens for this profile, else the phone's own speech recognition.
//
// The phone's recognition runs until the person stops it (owner, 2026-09-27): short pauses do
// not end it. The words appear in the composer while they are spoken, and the strip over the
// composer shows how loud the microphone hears them. When iOS ends a stretch on its own — after
// a pause, or at its time limit — what was heard is kept and a new stretch starts on the same
// microphone, so nothing is lost and nothing has to be pressed again.
import AVFoundation
import Foundation
import Observation
import Speech

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

    /// How many bars the strip's waveform draws.
    static let levelCount = 28

    private(set) var state: State = .idle
    /// What has been heard so far in this take: every finished stretch, then the one in progress.
    private(set) var heard = ""
    /// The microphone's loudness over the last moments, 0…1, oldest first.
    private(set) var levels = [Float](repeating: 0, count: Dictation.levelCount)
    /// The language the phone listens in during this take; nil while the hub listens.
    private(set) var listeningIn: String?

    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private let feed = Feed()
    @ObservationIgnored private var recognizer: SFSpeechRecognizer?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    /// Which stretch the results belong to: a late result of an ended one is dropped.
    @ObservationIgnored private var stretch = 0
    @ObservationIgnored private var stretchStartedAt = Date()
    /// Stretches that failed at once, in a row: three mean the recognizer cannot listen now.
    @ObservationIgnored private var quickFailures = 0
    @ObservationIgnored private var committed = ""
    @ObservationIgnored private var partial = ""
    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var meter: Task<Void, Never>?
    @ObservationIgnored private var transcribe: Transcribe?
    @ObservationIgnored private var l10n = L10n(.en)
    @ObservationIgnored private var startedAt = Date()

    /// Listens: into a recording for `hub` when it is given, else with the phone's recognizer in
    /// the first of `languages` it supports (DictationLanguage.candidates).
    func start(languages: [String], l10n: L10n, hub: Transcribe? = nil) async {
        guard state != .listening, state != .transcribing else { return }
        self.l10n = l10n
        committed = ""
        partial = ""
        heard = ""
        quickFailures = 0
        levels = [Float](repeating: 0, count: Dictation.levelCount)
        if let hub {
            await record(for: hub)
            return
        }
        let speech = await withCheckedContinuation { (continuation: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized, await AVAudioApplication.requestRecordPermission() else {
            state = .failed(l10n("voice.denied"))
            return
        }
        let supported = SFSpeechRecognizer.supportedLocales().map(\.identifier)
        guard let identifier = DictationLanguage.match(languages, supported: supported),
              let recognizer = SFSpeechRecognizer(locale: Locale(identifier: identifier)),
              recognizer.isAvailable
        else {
            state = .failed(l10n("voice.unavailable"))
            return
        }
        self.recognizer = recognizer
        listeningIn = DictationLanguage.tag(identifier)
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let input = engine.inputNode
            input.removeTap(onBus: 0)
            input.installTap(
                onBus: 0, bufferSize: 2048, format: input.outputFormat(forBus: 0),
                block: Dictation.tap(feed: feed) { [weak self] level in
                    Task { @MainActor in self?.push(level) }
                }
            )
            engine.prepare()
            try engine.start()
            startedAt = Date()
            state = .listening
            listen()
        } catch {
            state = .failed(l10n("voice.unavailable"))
            teardown()
        }
    }

    /// One recognition task over the running microphone.
    private func listen() {
        guard let recognizer else { return }
        stretch += 1
        let current = stretch
        stretchStartedAt = Date()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.addsPunctuation = true
        // On the phone when it can: private, and without the server's one-minute limit.
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        feed.request = request
        task = recognizer.recognitionTask(with: request) { result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor [weak self] in
                self?.received(text, final: final, failed: failed, stretch: current)
            }
        }
    }

    private func received(_ text: String?, final: Bool, failed: Bool, stretch current: Int) {
        guard current == stretch, state == .listening else { return }
        if let text {
            // iOS may begin a new stretch by itself after a pause: keep the one before.
            if Dictation.restarted(previous: partial, next: text) { commit() }
            partial = text
            if !text.isEmpty { quickFailures = 0 }
            heard = Dictation.join(committed, partial)
        }
        guard final || failed else { return }
        commit()
        if failed, partial.isEmpty, Date().timeIntervalSince(stretchStartedAt) < 1 {
            quickFailures += 1
        }
        if quickFailures >= 3 {
            state = .failed(l10n("voice.unavailable"))
            teardown()
            return
        }
        // The stretch ended (a pause, the time limit): the take goes on until the person stops.
        feed.request?.endAudio()
        task = nil
        listen()
    }

    private func commit() {
        guard !partial.isEmpty else { return }
        committed = Dictation.join(committed, partial)
        partial = ""
        heard = committed
    }

    private func push(_ level: Float) {
        guard state == .listening else { return }
        levels.removeFirst()
        levels.append(level)
    }

    /// Records to a file (AAC, 16 kHz mono: small, and the hub takes m4a) until `stop()`.
    private func record(for hub: @escaping Transcribe) async {
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
            recorder.isMeteringEnabled = true
            guard recorder.record() else { throw CocoaError(.fileWriteUnknown) }
            self.recorder = recorder
            transcribe = hub
            startedAt = Date()
            listeningIn = nil
            state = .listening
            meter = Task { [weak self] in
                while !Task.isCancelled {
                    guard let self, let recorder = self.recorder else { return }
                    recorder.updateMeters()
                    self.push(Dictation.level(decibels: recorder.averagePower(forChannel: 0)))
                    try? await Task.sleep(nanoseconds: 80_000_000)
                }
            }
        } catch {
            state = .failed(l10n("voice.unavailable"))
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    /// Ends the take and keeps its words: the phone stops listening; a recording goes to the hub.
    func stop() {
        if let recorder {
            finishRecording(recorder, keep: true)
            return
        }
        stretch += 1
        commit()
        teardown()
        if state == .listening { state = .idle }
    }

    /// Ends the take and drops it: nothing more is heard, a recording is not sent.
    func cancel() {
        if let recorder {
            finishRecording(recorder, keep: false)
            return
        }
        stretch += 1
        teardown()
        if state == .listening { state = .idle }
    }

    private func teardown() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        feed.request?.endAudio()
        feed.request = nil
        task?.cancel()
        task = nil
        recognizer = nil
        levels = [Float](repeating: 0, count: Dictation.levelCount)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func finishRecording(_ recorder: AVAudioRecorder, keep: Bool) {
        meter?.cancel()
        meter = nil
        recorder.stop()
        self.recorder = nil
        levels = [Float](repeating: 0, count: Dictation.levelCount)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        let file = recorder.url
        guard keep, let transcribe else {
            self.transcribe = nil
            try? FileManager.default.removeItem(at: file)
            state = .idle
            return
        }
        self.transcribe = nil
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

    // MARK: - The rules, apart from the audio, so they are tested

    /// A silent take is a hint, not an error (`400` with `details.reason: no_speech`).
    static func describe(_ error: Error, l10n: L10n) -> String {
        let failure = HubFailure(error)
        if failure.status == 400, failure.reason == "no_speech" { return l10n("voice.no_speech") }
        return failure.describe(l10n)
    }

    /// Two stretches of words as one text.
    nonisolated static func join(_ first: String, _ second: String) -> String {
        let a = first.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = second.trimmingCharacters(in: .whitespacesAndNewlines)
        if a.isEmpty { return b }
        if b.isEmpty { return a }
        return a + " " + b
    }

    /// Whether the recognizer started over (its text no longer continues what it had): a much
    /// shorter text that does not begin the way the previous one did.
    nonisolated static func restarted(previous: String, next: String) -> Bool {
        let before = previous.trimmingCharacters(in: .whitespaces)
        let after = next.trimmingCharacters(in: .whitespaces)
        guard before.count >= 8, !after.isEmpty, after.count < before.count / 2 else { return false }
        let firstWord = { (text: String) in text.split(separator: " ").first.map { $0.lowercased() } ?? "" }
        return firstWord(before) != firstWord(after)
    }

    /// Decibels (−160…0, as `AVAudioRecorder` reports them) as a bar height, 0…1.
    nonisolated static func level(decibels: Float) -> Float {
        guard decibels.isFinite else { return 0 }
        return max(0, min(1, (decibels + 50) / 45))
    }

    /// The microphone tap: each buffer goes to the current request, and its loudness to `level`.
    nonisolated private static func tap(feed: Feed, level: @escaping @Sendable (Float) -> Void) -> AVAudioNodeTapBlock {
        { buffer, _ in
            feed.append(buffer)
            guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
            var sum: Float = 0
            for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
            let rms = (sum / Float(buffer.frameLength)).squareRoot()
            level(Dictation.level(decibels: 20 * log10(max(rms, 0.000_001))))
        }
    }

    /// The request the microphone feeds, swapped between stretches; the tap runs on the audio
    /// thread, so it is read under a lock.
    private final class Feed: @unchecked Sendable {
        private let lock = NSLock()
        private var current: SFSpeechAudioBufferRecognitionRequest?

        var request: SFSpeechAudioBufferRecognitionRequest? {
            get { lock.withLock { current } }
            set { lock.withLock { current = newValue } }
        }

        func append(_ buffer: AVAudioPCMBuffer) {
            request?.append(buffer)
        }
    }
}
