import XCTest
@testable import HermesStudio

/// Server voice for the spoken reply: settings decoding, the synthesize
/// request body, provider selection and every error path.
final class VoiceOutputTests: XCTestCase {

    // MARK: - GET /api/studio/tts/settings

    func testSettingsDecodeTheServerSettingsKeyAndStoredSecretMarker() {
        let settings = TtsSettings([
            "settings": [
                ["provider": "elevenlabs",
                 "settings": ["voice": "Rachel", "model": "eleven_multilingual_v2", "baseUrlPresets": ["https://a.example"]],
                 "secrets": ["apiKey": "[stored]"]],
            ],
            "activeProvider": "elevenlabs",
        ])

        XCTAssertEqual(settings.activeProvider, "elevenlabs")
        let row = settings.setting(for: "elevenlabs")
        XCTAssertEqual(row?.options["voice"], "Rachel")
        XCTAssertEqual(row?.options["model"], "eleven_multilingual_v2")
        // The presets array is not a string setting and never becomes an option.
        XCTAssertNil(row?.options["baseUrlPresets"])
        XCTAssertEqual(row?.baseUrlPresets, ["https://a.example"])
        XCTAssertTrue(row?.hasStoredKey == true)
        XCTAssertEqual(row?.detail, "Rachel · eleven_multilingual_v2")
    }

    func testSettingsAlsoAcceptTheProvidersKeyUsedByTheWebNormaliser() {
        let settings = TtsSettings(["providers": [["provider": "groq", "settings": ["voice": "Aaliyah-PlayAI"]]], "activeProvider": "groq"])
        XCTAssertEqual(settings.providers.map(\.provider), ["groq"])
        XCTAssertEqual(settings.activeProvider, "groq")
    }

    func testNullActiveProviderReadsAsNone() {
        // JSONSerialization decodes JSON null as NSNull, never nil.
        let settings = TtsSettings(["settings": [] as [Any], "activeProvider": NSNull()])
        XCTAssertNil(settings.activeProvider)
        XCTAssertTrue(settings.providers.isEmpty)
    }

    func testUnknownProvidersAreDropped() {
        let settings = TtsSettings([
            "settings": [["provider": "edge", "settings": [String: Any]()], ["provider": "made-up", "settings": [String: Any]()]],
            "activeProvider": "made-up",
        ])
        XCTAssertEqual(settings.providers.map(\.provider), ["edge"])
        XCTAssertNil(settings.activeProvider)
    }

    func testSelectablesIncludeTheServerActiveProviderWithoutAStoredRow() {
        // The server resolves to `edge` when the profile has no active
        // provider, so the owner must be able to see and change it.
        let settings = TtsSettings(["settings": [["provider": "openai", "settings": [String: Any]()]], "activeProvider": "edge"])
        XCTAssertEqual(settings.selectableProviders, ["openai", "edge"])
    }

    // MARK: - POST /api/studio/tts/synthesize body

    func testBodyCarriesProviderAndTheProvidersStoredOptions() {
        let body = TtsRequest.body(text: "مرحبا", provider: "elevenlabs",
                                   options: ["voice": "Rachel", "model": "eleven_multilingual_v2", "rate": ""])
        XCTAssertEqual(body.string("text"), "مرحبا")
        XCTAssertEqual(body.string("provider"), "elevenlabs")
        let options = body.object("options")
        XCTAssertEqual(options.string("voice"), "Rachel")
        XCTAssertEqual(options.string("model"), "eleven_multilingual_v2")
        // An empty value would override the stored one on the server.
        XCTAssertNil(options["rate"])
    }

    func testBodyNeverEchoesTheApiKeyOrThePresetList() {
        let options = TtsRequest.options(["apiKey": "[stored]", "baseUrlPresets": "x", "voice": "Rachel"])
        XCTAssertEqual(options, ["voice": "Rachel"])
    }

    func testBodyOmitsTheProviderWhenNoneIsKnown() {
        let body = TtsRequest.body(text: "hello", provider: nil, options: [:])
        XCTAssertNil(body["provider"])
        XCTAssertTrue(body.object("options").isEmpty)
        XCTAssertEqual(body.string("text"), "hello")

        XCTAssertNil(TtsRequest.body(text: "hello", provider: "  ", options: [:])["provider"])
    }

    func testSettingsRouteKeepsItsFullUrl() throws {
        // `URL.path` drops a trailing component differently across platforms;
        // compare the whole URL instead.
        let api = APIClient(baseURL: "https://hub.example", token: "t")
        XCTAssertEqual(try api.url("/api/studio/tts/settings").absoluteString, "https://hub.example/api/studio/tts/settings")
        XCTAssertEqual(try api.url("/api/studio/tts/settings/active").absoluteString, "https://hub.example/api/studio/tts/settings/active")
        XCTAssertEqual(try api.url("/api/studio/tts/synthesize").absoluteString, "https://hub.example/api/studio/tts/synthesize")
    }

    // MARK: - Which voice speaks

    func testNothingStoredFollowsTheProfilesActiveServerProvider() {
        XCTAssertEqual(VoiceOutputSelection.choice(stored: "", serverActive: "elevenlabs"), .server("elevenlabs"))
    }

    func testNothingStoredAndNoActiveProviderLetsTheServerResolve() {
        XCTAssertEqual(VoiceOutputSelection.choice(stored: "", serverActive: nil), .serverDefault)
        XCTAssertNil(VoiceOutputChoice.serverDefault.provider)
    }

    func testStoredDeviceChoiceWins() {
        XCTAssertEqual(VoiceOutputSelection.choice(stored: "device", serverActive: "elevenlabs"), .device)
        XCTAssertNil(VoiceOutputChoice.device.provider)
    }

    func testStoredServerProviderWinsOverTheServerActiveOne() {
        XCTAssertEqual(VoiceOutputSelection.choice(stored: "groq", serverActive: "edge"), .server("groq"))
        XCTAssertEqual(VoiceOutputChoice.server("groq").provider, "groq")
    }

    func testAProviderThisBuildDoesNotKnowFallsBackToTheServerActiveOne() {
        XCTAssertEqual(VoiceOutputSelection.choice(stored: "retired-provider", serverActive: "openai"), .server("openai"))
    }

    // MARK: - PUT /api/studio/tts/settings/active is never silent

    func testPickingTheDeviceVoiceNeverWritesTheProfilesActiveProvider() {
        let plan = VoiceOutputSelection.plan(for: .device, serverActive: "elevenlabs")
        XCTAssertEqual(plan.stored, "device")
        XCTAssertNil(plan.activeProviderWrite)
    }

    func testPickingAServerProviderWritesItOnlyWhenItChanges() {
        let changed = VoiceOutputSelection.plan(for: .server("groq"), serverActive: "edge")
        XCTAssertEqual(changed.stored, "groq")
        XCTAssertEqual(changed.activeProviderWrite, "groq")

        let unchanged = VoiceOutputSelection.plan(for: .server("edge"), serverActive: "edge")
        XCTAssertEqual(unchanged.stored, "edge")
        XCTAssertNil(unchanged.activeProviderWrite)
    }

    // MARK: - Error paths

    func testJsonErrorBodyJoinsTheServersErrorAndDetail() {
        let data = Data(#"{"error":"TTS synthesis failed","detail":"ElevenLabs returned 401"}"#.utf8)
        XCTAssertEqual(TtsErrorBody.detail(data), "TTS synthesis failed: ElevenLabs returned 401")
    }

    func testJsonErrorBodyWithOnlyOneFieldUsesIt() {
        XCTAssertEqual(TtsErrorBody.detail(Data(#"{"error":"unknown TTS provider"}"#.utf8)), "unknown TTS provider")
        XCTAssertEqual(TtsErrorBody.detail(Data(#"{"detail":"connect ECONNREFUSED"}"#.utf8)), "connect ECONNREFUSED")
    }

    func testPlainTextErrorBodyIsTrimmedAndTruncated() {
        XCTAssertEqual(TtsErrorBody.detail(Data("  Bad Gateway \n".utf8)), "Bad Gateway")
        let long = TtsErrorBody.detail(Data(String(repeating: "x", count: 400).utf8))
        XCTAssertEqual(long.count, 301)
        XCTAssertTrue(long.hasSuffix("…"))
        XCTAssertEqual(TtsErrorBody.detail(Data()), "")
    }

    func testAJsonBodyReturnedWithAudioHeadersIsStillDetected() {
        // Studio answers some provider failures with JSON and HTTP 200.
        let json = Data(#"{"error":"TTS synthesis failed"}"#.utf8)
        XCTAssertTrue(TtsErrorBody.looksLikeJSON(contentType: "audio/mpeg", data: json))
        XCTAssertTrue(TtsErrorBody.looksLikeJSON(contentType: "application/json; charset=utf-8", data: Data()))
        XCTAssertTrue(TtsErrorBody.looksLikeJSON(contentType: "audio/mpeg", data: Data("\n  {\"error\":\"x\"}".utf8)))
    }

    func testRealAudioIsNotMistakenForAnErrorBody() {
        XCTAssertFalse(TtsErrorBody.looksLikeJSON(contentType: "audio/mpeg", data: Data("ID3\u{03}".utf8)))
        XCTAssertFalse(TtsErrorBody.looksLikeJSON(contentType: "audio/wav", data: Data("RIFF".utf8)))
        XCTAssertFalse(TtsErrorBody.looksLikeJSON(contentType: "audio/mpeg", data: Data()))
    }

    func testFailureMessageNamesTheProviderTheStatusAndTheServerText() {
        let message = TtsFailure(provider: "elevenlabs", status: 401, detail: "invalid api key").localizedDescription
        XCTAssertTrue(message.contains("ElevenLabs TTS"), message)
        XCTAssertTrue(message.contains("401"), message)
        XCTAssertTrue(message.contains("invalid api key"), message)
    }

    func testFailureMessageWithoutDetailStillNamesTheStatus() {
        let message = TtsFailure(provider: "groq", status: 502, detail: "  ").localizedDescription
        XCTAssertTrue(message.contains("Groq TTS"), message)
        XCTAssertTrue(message.contains("502"), message)
    }

    func testTransportFailureHasNoStatusButKeepsItsReason() {
        let message = TtsFailure(provider: "openai", status: 0, detail: "The request timed out.").localizedDescription
        XCTAssertTrue(message.contains("OpenAI TTS"), message)
        XCTAssertTrue(message.contains("The request timed out."), message)
        XCTAssertFalse(message.contains("HTTP"), message)
    }

    func testFailureWithoutAProviderNameStillReads() {
        let message = TtsFailure(provider: "", status: 0, detail: "").localizedDescription
        XCTAssertFalse(message.isEmpty)
        XCTAssertFalse(message.contains("HTTP"), message)
    }

    func testFallbackNoticeQuotesTheFailureBeforeTheDeviceVoiceTakesOver() {
        let notice = VoiceFallbackNotice.message(for: TtsFailure(provider: "elevenlabs", status: 401, detail: "invalid api key"))
        XCTAssertTrue(notice.contains("ElevenLabs TTS"), notice)
        XCTAssertTrue(notice.contains("401"), notice)
    }

    // MARK: - Provider catalog

    func testCatalogMatchesTheServersStoredProviderList() {
        XCTAssertEqual(TtsProviderCatalog.all.sorted(), [
            "custom", "deepinfra", "doubao", "edge", "elevenlabs", "gemini",
            "groq", "mimo", "minimax", "mistral", "openai", "xai",
        ])
        XCTAssertEqual(TtsProviderCatalog.label("edge"), "Edge TTS")
        XCTAssertEqual(TtsProviderCatalog.label("unknown"), "unknown")
        XCTAssertFalse(TtsProviderCatalog.isKnown("webspeech"))
    }
}
