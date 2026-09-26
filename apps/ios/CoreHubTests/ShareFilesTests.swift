@testable import CoreHub
import XCTest

/// Share to Core Hub with pictures and files (B14): the extension's copies wait in the App Group
/// folder under their own names, and the app takes them once.
final class ShareFilesTests: XCTestCase {
    private var folder: URL!
    private var source: URL!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("share-\(UUID().uuidString)", isDirectory: true)
        folder = root.appendingPathComponent("inbox", isDirectory: true)
        source = root.appendingPathComponent("src", isDirectory: true)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        defaults = UserDefaults(suiteName: "share-tests-\(UUID().uuidString)")
    }

    private func file(_ name: String, _ text: String = "x") throws -> URL {
        let url = source.appendingPathComponent(name)
        try Data(text.utf8).write(to: url)
        return url
    }

    func testFilesWaitUnderTheirOwnNamesNumberedWhenTakenAndAreTakenOnce() throws {
        let photo = try file("photo.jpg")
        XCTAssertNotNil(ShareInbox.putFile(photo, in: defaults, folder: folder))
        XCTAssertNotNil(ShareInbox.putFile(photo, in: defaults, folder: folder))
        XCTAssertNotNil(ShareInbox.putFile(try file("report.pdf"), name: "التقرير.pdf", in: defaults, folder: folder))
        let taken = ShareInbox.takeFiles(from: defaults, folder: folder)
        XCTAssertEqual(taken.map(\.lastPathComponent), ["photo.jpg", "photo-2.jpg", "التقرير.pdf"])
        XCTAssertTrue(taken.allSatisfy { FileManager.default.fileExists(atPath: $0.path) })
        XCTAssertTrue(ShareInbox.takeFiles(from: defaults, folder: folder).isEmpty, "taking empties the inbox")
    }

    func testANameNeverLeavesTheFolder() {
        XCTAssertEqual(ShareInbox.safeName("../../etc/passwd"), "passwd")
        XCTAssertEqual(ShareInbox.safeName(".hidden"), "hidden")
        XCTAssertEqual(ShareInbox.safeName("   "), "file")
        XCTAssertEqual(ShareInbox.safeName("a:b.txt"), "a_b.txt")
    }
}
