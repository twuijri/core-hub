@testable import CoreHub
import CoreHubClient
import XCTest

/// Opening a conversation's files on iOS (docs/changes/2026-09-26-twuijri-mobile-open-files.md):
/// which way each kind opens, which file a reply's link names, and the download through the
/// generated client against a stand-in hub — the bearer header, the profile, the cache and the
/// ticket's address. No hub path is typed here: every one comes from the generated client.
@MainActor
final class HubFilesTests: XCTestCase {
    private let id = "01J8QK3ZR2W7M5N4P6T8V9X0AA"
    private let pdfID = "01J8QK3ZR2W7M5N4P6T8V9X0AB"
    private let hub = URL(string: "https://hub.example.test")!

    // ------------------------------------------------------------------ how each kind opens

    func testPicturesDrawDocumentsOpenInTheViewerSoundAndVideoPlayTheRestIsShared() {
        XCTAssertEqual(FileKinds.openAs("photo-20260926-175004.jpg", "image/jpeg"), .picture)
        XCTAssertEqual(FileKinds.openAs("retouch.png", "application/octet-stream"), .picture)
        XCTAssertEqual(FileKinds.openAs("plan.svg", "image/svg+xml"), .viewer)
        XCTAssertEqual(FileKinds.openAs("report.pdf", "application/pdf"), .viewer)
        XCTAssertEqual(FileKinds.openAs("notes.txt", "text/plain; charset=utf-8"), .viewer)
        XCTAssertEqual(FileKinds.openAs("budget.xlsx", nil), .viewer)
        XCTAssertEqual(FileKinds.openAs("voice.m4a", "audio/mp4"), .media)
        XCTAssertEqual(FileKinds.openAs("render.mp4", nil), .media)
        XCTAssertEqual(FileKinds.openAs("backup.zip", "application/zip"), .share)
        XCTAssertEqual(FileKinds.openAs("blob", nil), .share)
    }

    func testAPictureSentAsAFileIsDrawnAnImageThePhoneCannotDrawIsARow() {
        let blocks: [ContentBlock] = [
            .typeFileBlock(FileBlock(attachmentId: id, name: "photo.jpg", mime: "image/jpeg", sizeBytes: 10, type: .file)),
            .typeImageBlock(ImageBlock(attachmentId: id, name: "plan.svg", mime: "image/svg+xml", type: .image)),
            .typeImageBlock(ImageBlock(attachmentId: id, name: "scan", type: .image)),
            .typeFileBlock(FileBlock(attachmentId: pdfID, name: "report.pdf", mime: "application/pdf", sizeBytes: 2048, type: .file)),
        ]
        let files = MessageAttachments.files(blocks)
        XCTAssertEqual(files.map(\.isImage), [true, false, true, false])
        XCTAssertEqual(files[3].hubFile, .attachment(id: pdfID, name: "report.pdf", mime: "application/pdf", size: 2048))
    }

    // ------------------------------------------------------------------ links in a reply

    private var reply: [MessageAttachments.File] {
        [
            .init(id: 0, attachmentID: id, name: "retouch-this-exact-photo-20260926-175416-1.png", isImage: true, mime: "image/png", size: 4096, url: FileLinks.contentPath(id)),
            .init(id: 1, attachmentID: pdfID, name: "تقرير.pdf", isImage: false, mime: "application/pdf", url: FileLinks.contentPath(pdfID)),
        ]
    }

    func testTheContentPathIsTheGeneratedClientsOwn() {
        let builder = SessionsAPI.sessionsDownloadAttachmentWithRequestBuilder(xHubProfile: "work", attachmentId: id)
        XCTAssertTrue(builder.URLString.hasSuffix(FileLinks.contentPath(id)))
        XCTAssertTrue(FileLinks.contentPath(id).hasPrefix(CoreHubClientAPIConfiguration().basePath + "/"))
    }

    func testALinkToAnAttachmentsAddressRelativeOrOnTheHubOpensThatAttachment() {
        let relative = FileLinks.resolve(FileLinks.contentPath(id), hub: hub, own: reply)
        XCTAssertEqual(relative, .attachment(id: id, name: reply[0].name, mime: "image/png", size: 4096))
        XCTAssertEqual(FileLinks.resolve(hub.absoluteString + FileLinks.contentPath(id), hub: hub, own: reply), relative)
        XCTAssertNil(FileLinks.resolve("https://elsewhere.example" + FileLinks.contentPath(id), hub: hub, own: reply), "another site is an ordinary link")
    }

    func testALinkByNameOpensTheReplysOwnFileEncodedNamesIncluded() {
        XCTAssertEqual(FileLinks.resolve("retouch-this-exact-photo-20260926-175416-1.png", hub: hub, own: reply)?.cacheKey, id)
        XCTAssertEqual(FileLinks.resolve("./out/retouch-this-exact-photo-20260926-175416-1.png", hub: hub, own: reply)?.cacheKey, id)
        XCTAssertEqual(FileLinks.resolve("%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf", hub: hub, own: reply)?.cacheKey, pdfID)
        XCTAssertEqual(FileLinks.resolve("sandbox:/mnt/data/retouch-this-exact-photo-20260926-175416-1.png", hub: hub, own: reply)?.cacheKey, id)
    }

    func testALinkToTheWorkingFolderOpensThatFileOtherLinksStayLinks() {
        let files = [
            SessionFile(
                key: "path:out/report.html", name: "report.html", path: "out/report.html", mime: "text/html", preview: .html,
                sizeBytes: 2048, previewMaxBytes: 5_242_880, sources: [.tool], toolCallIds: []
            ),
        ]
        guard case .working(let session, let path, _, _, _, _) = FileLinks.resolve("./out/report.html", hub: hub, own: reply, files: files, sessionID: "S1") else {
            return XCTFail("the folder's file")
        }
        XCTAssertEqual(session, "S1")
        XCTAssertEqual(path, "out/report.html")
        XCTAssertNotNil(FileLinks.resolve("/data/workspaces/default/S1/out/report.html", hub: hub, own: reply, files: files, sessionID: "S1"))
        XCTAssertNil(FileLinks.resolve("https://example.com/report.html", hub: hub, own: reply, files: files, sessionID: "S1"))
        XCTAssertNil(FileLinks.resolve("#section", hub: hub, own: reply, files: files, sessionID: "S1"))
        XCTAssertNil(FileLinks.resolve("mailto:someone@example.com", hub: hub, own: reply, files: files, sessionID: "S1"))
        XCTAssertNil(FileLinks.resolve("unknown.html", hub: hub, own: reply, files: files, sessionID: "S1"))
    }

    // ------------------------------------------------------------------ the download

    private func configuration(_ stub: StubHub) -> CoreHubClientAPIConfiguration {
        let config = HubAPI.configuration(hub: hub, bearer: "tok-1", language: .ar)
        config.requestBuilderFactory = stub
        return config
    }

    func testAnAttachmentIsFetchedWithTheBearerHeaderAndKeptUnderItsName() async throws {
        let bytes = Data(repeating: 7, count: 4096)
        let stub = StubHub { _ in (200, bytes, ["Content-Type": "image/png", "Content-Disposition": "attachment; filename=\"retouch.png\""]) }
        let file = HubFile.attachment(id: id, name: "retouch.png", mime: "image/png", size: 4096)
        let downloaded = try await HubFileFetcher.download(file, profile: "work", config: configuration(stub)) { _ in }
        let request = try XCTUnwrap(stub.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, FileLinks.contentPath(id))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Hub-Profile"), "work")

        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let kept = try HubFileFetcher.keep(downloaded, as: file, in: root)
        XCTAssertEqual(kept, root.appendingPathComponent(id).appendingPathComponent("retouch.png"))
        XCTAssertEqual(try Data(contentsOf: kept), bytes)
        XCTAssertEqual(HubFileFetcher.cached(file, in: root), kept, "a second open reads the phone's copy")
        XCTAssertNil(HubFileFetcher.cached(.attachment(id: id, name: "retouch.png", mime: nil, size: 9), in: root), "not the whole file")
    }

    func testAFileOfTheWorkingFolderIsFetchedForDownload() async throws {
        let stub = StubHub { _ in (200, Data("<p>hi</p>".utf8), ["Content-Type": "text/html"]) }
        let file = HubFile.working(sessionID: "S1", path: "out/report.html", name: "report.html", mime: "text/html", size: 9, modified: nil)
        _ = try await HubFileFetcher.download(file, profile: "default", config: configuration(stub)) { _ in }
        let request = try XCTUnwrap(stub.requests.first)
        let expected = SessionsAPI.sessionsReadFileWithRequestBuilder(xHubProfile: "default", sessionId: "S1", path: "out/report.html", download: true)
        XCTAssertEqual(request.url?.path, URLComponents(string: expected.URLString)?.path)
        let query = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(query.first { $0.name == "path" }?.value, "out/report.html")
        XCTAssertEqual(query.first { $0.name == "download" }?.value, "true")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-1")
    }

    func testARefusalIsTheHubsError() async {
        let stub = StubHub { _ in (404, Data(#"{"error":"Not found","code":"not_found"}"#.utf8), ["Content-Type": "application/json"]) }
        do {
            _ = try await HubFileFetcher.download(.attachment(id: id, name: "x.png", mime: nil, size: nil), profile: "work", config: configuration(stub)) { _ in }
            XCTFail("a 404 is not a file")
        } catch {
            XCTAssertEqual(HubFailure(error).status, 404)
            XCTAssertEqual(HubFailure(error).code, "not_found")
        }
    }

    func testSoundAndVideoPlayFromTheContractsTicketResolvedAgainstTheHub() async throws {
        let stub = StubHub { _ in (201, Data(#"{"url":"/streams/7c1b0e5f","expires_at":"2026-09-26T11:14:50Z"}"#.utf8), ["Content-Type": "application/json"]) }
        let address = try await HubFileFetcher.streamAddress(
            .attachment(id: id, name: "voice.m4a", mime: "audio/mp4", size: nil), profile: "work", hub: hub, config: configuration(stub)
        )
        XCTAssertEqual(address.absoluteString, "https://hub.example.test/streams/7c1b0e5f")
        let request = try XCTUnwrap(stub.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        let expected = SessionsAPI.sessionsCreateAttachmentStreamWithRequestBuilder(xHubProfile: "work", attachmentId: id)
        XCTAssertEqual(request.url?.path, URLComponents(string: expected.URLString)?.path)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-1")
    }
}

/// A stand-in hub for the generated client: records each request and answers with `answer`.
final class StubHub: RequestBuilderFactory, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [URLRequest] = []
    let answer: (URLRequest) -> (Int, Data, [String: String])

    init(_ answer: @escaping (URLRequest) -> (Int, Data, [String: String])) {
        self.answer = answer
    }

    var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func record(_ request: URLRequest) {
        lock.lock()
        recorded.append(request)
        lock.unlock()
    }

    func getNonDecodableBuilder<T>() -> RequestBuilder<T>.Type { StubRequestBuilder<T>.self }
    func getBuilder<T: Decodable>() -> RequestBuilder<T>.Type { StubDecodableRequestBuilder<T>.self }

    /// The session every stub builder uses: the factory of its configuration answers.
    final class Session: URLSessionProtocol, @unchecked Sendable {
        let hub: StubHub
        init(_ hub: StubHub) { self.hub = hub }

        func dataTaskFromProtocol(
            with request: URLRequest,
            completionHandler: @escaping @Sendable (Data?, URLResponse?, (any Error)?) -> Void
        ) -> URLSessionDataTaskProtocol {
            let hub = self.hub
            return DemoTask {
                hub.record(request)
                let (status, body, headers) = hub.answer(request)
                let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)
                completionHandler(body, response, nil)
            }
        }
    }
}

final class StubRequestBuilder<T>: URLSessionRequestBuilder<T>, @unchecked Sendable {
    override func createURLSession() -> URLSessionProtocol {
        StubHub.Session(apiConfiguration.requestBuilderFactory as! StubHub)
    }
}

final class StubDecodableRequestBuilder<T: Decodable>: URLSessionDecodableRequestBuilder<T>, @unchecked Sendable {
    override func createURLSession() -> URLSessionProtocol {
        StubHub.Session(apiConfiguration.requestBuilderFactory as! StubHub)
    }
}
