@testable import CoreHub
import CoreHubClient
import UIKit
import XCTest

/// Files in the composer (docs/changes/2026-09-26-twuijri-mobile-polish.md §٤).
@MainActor
final class AttachmentTests: XCTestCase {
    private func attachment(_ id: String, kind: Attachment.Kind, name: String) -> Attachment {
        Attachment(
            id: id, profile: "work", ownerId: "01J8QK3ZR2W7M5N4P6T8V9X0HM", createdAt: Fixture.date,
            updatedAt: Fixture.date, name: name, mime: kind == .image ? "image/jpeg" : "application/pdf",
            sizeBytes: 1234, kind: kind, url: "/api/v1/attachments/\(id)/content", purpose: .message,
            sha256: String(repeating: "0", count: 64)
        )
    }

    func testTheMessageCarriesTextThenOneBlockPerFile() {
        let photo = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AA", kind: .image, name: "photo.jpg")
        let pdf = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AB", kind: .file, name: "plan.pdf")
        let message = OutgoingMessage(text: "  look  ", attachments: [photo, pdf])
        let blocks = message.blocks
        XCTAssertEqual(blocks.count, 3)
        guard case .typeTextBlock(let text) = blocks[0] else { return XCTFail("text first") }
        XCTAssertEqual(text.text, "look")
        guard case .typeImageBlock(let image) = blocks[1] else { return XCTFail("the photo as an image block") }
        XCTAssertEqual(image.attachmentId, photo.id)
        XCTAssertEqual(image.name, "photo.jpg")
        guard case .typeFileBlock(let file) = blocks[2] else { return XCTFail("the pdf as a file block") }
        XCTAssertEqual(file.attachmentId, pdf.id)

        // Files alone are a message; nothing at all is not.
        XCTAssertFalse(OutgoingMessage(text: " ", attachments: [pdf]).isEmpty)
        XCTAssertEqual(OutgoingMessage(text: " ", attachments: [pdf]).blocks.count, 1)
        XCTAssertTrue(OutgoingMessage(text: " \n").isEmpty)
    }

    func testPhotosShrinkToTheLongerSideLimitAndNeverGrow() {
        XCTAssertEqual(AttachmentRules.fitted(CGSize(width: 4032, height: 3024)), CGSize(width: 2048, height: 1536))
        XCTAssertEqual(AttachmentRules.fitted(CGSize(width: 3024, height: 4032)), CGSize(width: 1536, height: 2048))
        XCTAssertEqual(AttachmentRules.fitted(CGSize(width: 800, height: 600)), CGSize(width: 800, height: 600))

        let big = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 1500), format: {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return format
        }()).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 3000, height: 1500))
        }
        let data = try? XCTUnwrap(AttachmentRules.jpeg(big))
        let decoded = data.flatMap(UIImage.init(data:))
        XCTAssertEqual(decoded?.size, CGSize(width: 2048, height: 1024))
    }

    func testTheTrayUploadsAtOnceAndSendsOnlyWhatFinished() async throws {
        let uploaded = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AC", kind: .file, name: "notes.txt")
        var sentNames: [String] = []
        var profiles: [String] = []
        var discarded: [String] = []
        let gate = AsyncGate()
        let tray = AttachmentTray(
            upload: { file, profile in
                sentNames.append(file.lastPathComponent)
                profiles.append(profile)
                await gate.wait()
                return uploaded
            },
            discard: { discarded.append($0.id) },
            describe: { _ in "failed" },
            tooLarge: { _ in "too large" }
        )
        tray.add(data: Data("hello".utf8), name: "notes.txt", isImage: false, preview: nil, profile: "work")
        XCTAssertTrue(tray.uploading)
        XCTAssertTrue(tray.attachments.isEmpty, "nothing is sent while it is uploading")

        await gate.open()
        try await waitUntil { !tray.uploading }
        XCTAssertEqual(sentNames, ["notes.txt"], "the upload's file name is the attachment's name")
        XCTAssertEqual(profiles, ["work"], "into the chat's profile")
        XCTAssertEqual(tray.attachments, [uploaded])

        // The chip's ×: gone from the message, deleted on the hub.
        tray.remove(try XCTUnwrap(tray.items.first).id)
        try await waitUntil { !discarded.isEmpty }
        XCTAssertEqual(discarded, [uploaded.id])
        XCTAssertTrue(tray.isEmpty)
    }

    func testAFileOverTheHubsLimitIsRefusedBeforeUploading() {
        var uploads = 0
        let tray = AttachmentTray(
            upload: { _, _ in
                uploads += 1
                throw CancellationError()
            },
            discard: { _ in },
            describe: { _ in "failed" },
            tooLarge: { _ in "too large" }
        )
        tray.add(data: Data(count: AttachmentRules.maxBytes + 1), name: "big.bin", isImage: false, preview: nil, profile: "work")
        XCTAssertEqual(uploads, 0)
        XCTAssertEqual(tray.items.first?.state, .failed("too large"))
        XCTAssertFalse(tray.uploading)
    }

    func testTheHubsTooLargeAnswerReadsAsTheLimit() throws {
        let body = try JSONSerialization.data(withJSONObject: [
            "error": "Payload too large", "code": "payload_too_large", "details": ["max_bytes": 52_428_800],
        ])
        let failure = HubFailure(ErrorResponse.error(413, body, nil, URLError(.unknown)))
        XCTAssertEqual(failure.status, 413)
        XCTAssertEqual(failure.maxBytes, 52_428_800, "the hub's own figure")
        let l10n = L10n(.en)
        XCTAssertTrue(l10n.has("attachments.too_large"))
        XCTAssertTrue(l10n("attachments.too_large", ["size": "25 MB"]).contains("25 MB"))
    }

    private func waitUntil(_ condition: @escaping () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out", file: file, line: line)
    }
}

/// Original quality and the hub's own limit (docs/changes/2026-09-26-twuijri-mobile-polish-2.md).
@MainActor
final class PhotoQualityTests: XCTestCase {
    private func attachment(_ id: String, kind: Attachment.Kind) -> Attachment {
        Attachment(
            id: id, profile: "work", ownerId: "01J8QK3ZR2W7M5N4P6T8V9X0HM", createdAt: Fixture.date,
            updatedAt: Fixture.date, name: "photo.heic", mime: "image/heic", sizeBytes: 4_000_000, kind: kind,
            url: "/api/v1/attachments/\(id)/content", purpose: .message, sha256: String(repeating: "0", count: 64)
        )
    }

    func testAnOriginalPhotoGoesAsAFileAndACompressedOneAsAnImage() {
        let original = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AA", kind: .image)
        let compressed = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AB", kind: .image)
        let blocks = OutgoingMessage(text: "", attachments: [original, compressed], asFiles: [original.id]).blocks
        guard case .typeFileBlock(let file) = blocks[0] else { return XCTFail("the original goes as a file") }
        XCTAssertEqual(file.attachmentId, original.id)
        XCTAssertEqual(file.mime, "image/heic")
        guard case .typeImageBlock = blocks[1] else { return XCTFail("the compressed one as an image") }
    }

    func testTheTrayMarksOriginalPhotosAndTheirBytesAreUntouched() async throws {
        let uploaded = attachment("01J8QK3ZR2W7M5N4P6T8V9X0AC", kind: .image)
        var sent: Data?
        var names: [String] = []
        let tray = AttachmentTray(
            upload: { file, _ in
                sent = try Data(contentsOf: file)
                names.append(file.lastPathComponent)
                return uploaded
            },
            discard: { _ in }, describe: { _ in "failed" }, tooLarge: { _ in "too large" }
        )
        let bytes = Data((0..<4096).map { UInt8($0 % 251) })
        tray.addOriginalPhoto(bytes, type: .heic, profile: "work")
        for _ in 0..<200 where tray.uploading { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(sent, bytes, "not re-encoded, not resized")
        XCTAssertTrue(names.first?.hasSuffix(".heic") ?? false)
        XCTAssertEqual(tray.asFiles, [uploaded.id])
        XCTAssertEqual(tray.message("hi").asFiles, [uploaded.id])
    }

    func testCompressedIsTheDefaultAndTheChoiceIsRemembered() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "photo-quality-\(UUID().uuidString)"))
        XCTAssertEqual(DeviceSettings(defaults: defaults).photoQuality, .compressed)
        DeviceSettings(defaults: defaults).photoQuality = .original
        XCTAssertEqual(DeviceSettings(defaults: defaults).photoQuality, .original)
        for language in [AppLanguage.ar, .en] {
            for key in ["attachments.photo_quality", "attachments.compressed", "attachments.original"] {
                XCTAssertTrue(L10n(language).has(key), "\(key) in \(language)")
            }
        }
        XCTAssertEqual(L10n(.ar)("attachments.original"), "بالجودة الأصلية")
    }

    func testThePhoneKeepsTheContractsAttachmentLimit() throws {
        // UploadStart.size_bytes.maximum in openapi.yaml: the contract has no call that reports it.
        let yaml = try XCTUnwrap(String(data: Fixture.repositoryFile("openapi", "yaml"), encoding: .utf8))
        let start = try XCTUnwrap(yaml.range(of: "\n    UploadStart:\n"))
        let section = yaml[start.upperBound...].prefix(600)
        let maximum = try XCTUnwrap(section.range(of: #"maximum: (\d+)"#, options: .regularExpression))
        let value = Int(section[maximum].split(separator: " ").last ?? "")
        XCTAssertEqual(value, AttachmentRules.maxBytes)
        XCTAssertGreaterThan(AttachmentRules.maxBytes, AttachmentRules.maxOneShotBytes)
    }

    func testFilesOverTheOneRequestLimitGoInChunks() async throws {
        let backend = FakeUploads(chunkBytes: 10 * 1024 * 1024)
        let small = FileManager.default.temporaryDirectory.appendingPathComponent("small-\(UUID().uuidString).pdf")
        try Data(count: 1024).write(to: small)
        _ = try await AttachmentUploader(backend: backend).upload(small, profile: "work")
        XCTAssertEqual(backend.calls, ["oneShot"])

        let big = FileManager.default.temporaryDirectory.appendingPathComponent("big-\(UUID().uuidString).heic")
        let size = AttachmentRules.maxOneShotBytes + 3
        try Data(count: size).write(to: big)
        backend.calls = []
        _ = try await AttachmentUploader(backend: backend).upload(big, profile: "work")
        XCTAssertEqual(backend.calls, ["start", "chunk@0", "chunk@10485760", "chunk@20971520", "complete"])
        XCTAssertEqual(backend.started?.sizeBytes, size)
        XCTAssertEqual(backend.started?.mime, "image/heic")
        XCTAssertEqual(backend.received, size)

        backend.calls = []
        backend.failChunks = true
        do {
            _ = try await AttachmentUploader(backend: backend).upload(big, profile: "work")
            XCTFail("a failed chunk fails the upload")
        } catch {}
        XCTAssertEqual(backend.calls.last, "abort", "the open upload is let go")
    }
}

private final class FakeUploads: AttachmentBackend {
    let chunkBytes: Int
    var calls: [String] = []
    var started: UploadStart?
    var received = 0
    var failChunks = false

    init(chunkBytes: Int) { self.chunkBytes = chunkBytes }

    private func attachment() -> Attachment {
        Attachment(
            id: "01J8QK3ZR2W7M5N4P6T8V9X0AD", profile: "work", ownerId: "01J8QK3ZR2W7M5N4P6T8V9X0HM",
            createdAt: Fixture.date, updatedAt: Fixture.date, name: "f", mime: "application/pdf", sizeBytes: 1,
            kind: .file, url: "/x", purpose: .message, sha256: String(repeating: "0", count: 64)
        )
    }

    private func upload(_ next: Int) -> Upload {
        Upload(id: "01J8QK3ZR2W7M5N4P6T8V9X0WP", name: "f", mime: "m", sizeBytes: started?.sizeBytes ?? 0,
               chunkBytes: chunkBytes, nextOffset: next, expiresAt: Fixture.date)
    }

    func oneShot(_ file: URL, profile: String) async throws -> Attachment {
        calls.append("oneShot")
        return attachment()
    }

    func start(_ start: UploadStart, profile: String) async throws -> Upload {
        calls.append("start")
        started = start
        received = 0
        return upload(0)
    }

    func chunk(_ uploadID: String, offset: Int, body: URL, profile: String) async throws -> Upload {
        calls.append("chunk@\(offset)")
        if failChunks { throw URLError(.networkConnectionLost) }
        let bytes = try Data(contentsOf: body).count
        XCTAssertLessThanOrEqual(bytes, chunkBytes)
        received += bytes
        return upload(offset + bytes)
    }

    func complete(_ uploadID: String, profile: String) async throws -> Attachment {
        calls.append("complete")
        return attachment()
    }

    func abort(_ uploadID: String, profile: String) async {
        calls.append("abort")
    }
}

/// Holds an upload until the test lets it finish.
private actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }
}

/// Where the voice comes from (§٥): the hub's providers when chosen and ready, the phone otherwise.
@MainActor
final class VoiceSourceTests: XCTestCase {
    func testTheHubSpeaksOnlyWhenChosenAndReady() {
        XCTAssertEqual(VoiceRoute.choose(.hub, hubReady: true), .hub)
        XCTAssertEqual(VoiceRoute.choose(.hub, hubReady: false), .phone, "no provider on the hub")
        XCTAssertEqual(VoiceRoute.choose(.hub, hubReady: nil), .phone, "the hub could not be asked")
        XCTAssertEqual(VoiceRoute.choose(.phone, hubReady: true), .phone, "the person chose this phone")
    }

    func testThisPhoneIsTheDefaultAndAChoiceIsKept() throws {
        // Owner, 2026-09-26: «خل الأساسي حق الجوال ويقدر يغير المستخدم».
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "voice-source-\(UUID().uuidString)"))
        let settings = DeviceSettings(defaults: defaults)
        XCTAssertEqual(settings.voiceSource, .phone)
        // Changing another choice does not pin the voice: an install that never chose keeps
        // following the default.
        settings.spokenReplies = true
        settings.voiceInput = false
        XCTAssertNil(defaults.string(forKey: DeviceSettings.Keys.voiceSource))
        XCTAssertEqual(DeviceSettings(defaults: defaults).voiceSource, .phone)
        settings.voiceSource = .hub
        XCTAssertEqual(DeviceSettings(defaults: defaults).voiceSource, .hub)
        for language in [AppLanguage.ar, .en] {
            for key in ["device.voice_source", "device.voice_hub", "device.voice_phone", "voice.no_speech", "voice.transcribing"] {
                XCTAssertTrue(L10n(language).has(key), "\(key) in \(language)")
            }
        }
        XCTAssertEqual(L10n(.ar)("device.voice_phone"), "الجوال")
    }

    func testLongRepliesAreSpokenInPartsTheHubTakes() {
        let sentence = "This is one sentence of a long reply. "
        let text = String(repeating: sentence, count: 120)
        let parts = Voice.chunks(text)
        XCTAssertGreaterThan(parts.count, 1)
        XCTAssertTrue(parts.allSatisfy { $0.count <= 2000 })
        XCTAssertTrue(parts.allSatisfy { $0.hasSuffix(".") }, "cut at a sentence")
        XCTAssertEqual(parts.joined(separator: " "), text.trimmingCharacters(in: .whitespaces))
        XCTAssertEqual(Voice.chunks("short"), ["short"])
        XCTAssertEqual(Voice.chunks("  "), [])
    }

    func testASilentTakeIsAHintNotAnError() throws {
        let body = try JSONSerialization.data(withJSONObject: [
            "error": "No speech", "code": "validation_failed", "details": ["reason": "no_speech"],
        ])
        let error = ErrorResponse.error(400, body, nil, URLError(.unknown))
        XCTAssertEqual(HubFailure(error).reason, "no_speech")
        XCTAssertEqual(Dictation.describe(error, l10n: L10n(.en)), L10n(.en)("voice.no_speech"))
    }
}

/// Lucide icons (§٦): every generated one is in the catalogue as a template that draws.
final class LucideIconTests: XCTestCase {
    func testEveryLucideIconIsATemplateThatDraws() throws {
        XCTAssertFalse(Lucide.allCases.isEmpty)
        for icon in Lucide.allCases {
            let image = try XCTUnwrap(UIImage(named: "Lucide/\(icon.rawValue)"), "Lucide/\(icon.rawValue) is missing")
            XCTAssertEqual(image.renderingMode, .alwaysTemplate, icon.rawValue)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let drawn = UIGraphicsImageRenderer(size: CGSize(width: 48, height: 48), format: format).pngData { _ in
                image.draw(in: CGRect(x: 0, y: 0, width: 48, height: 48))
            }
            let blank = UIGraphicsImageRenderer(size: CGSize(width: 48, height: 48), format: format).pngData { _ in }
            XCTAssertNotEqual(drawn, blank, "\(icon.rawValue) draws nothing")
        }
    }
}
