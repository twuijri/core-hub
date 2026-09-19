import CoreGraphics
import XCTest
@testable import HermesStudio

/// The composer's "+" sheet: the rows it offers, their order, and the picker
/// each one launches. The view itself is not testable without a host, so only
/// the pure model is checked — the same order Android's
/// `AttachmentSheetTest` pins down.
final class AttachmentSheetTests: XCTestCase {

    private func groups(_ opened: @escaping (String) -> Void) -> [AttachmentGroup] {
        AttachmentMenu.groups(
            onCamera: { opened("camera") },
            onPhotos: { opened("photos") },
            onFiles: { opened("files") }
        )
    }

    func testRowsFollowTheWebOrderInTwoGroups() {
        let menu = groups { _ in }
        XCTAssertEqual(menu.map(\.id), ["photos", "documents"])
        XCTAssertEqual(menu.flatMap { $0.actions.map(\.id) }, ["camera", "library", "files"])
        XCTAssertEqual(menu.flatMap { $0.actions.map(\.icon) }, [.camera, .image, .paperclip])
    }

    func testEveryRowLaunchesItsOwnPicker() {
        var opened: [String] = []
        for action in groups({ opened.append($0) }).flatMap({ $0.actions }) { action.run() }
        XCTAssertEqual(opened, ["camera", "photos", "files"])
    }

    func testAttachmentIconsStayInsideTheViewBox() {
        for icon in [CoreHubIcon.camera, .image, .paperclip] {
            let path = IconPath.path(icon.shapes, in: CGRect(x: 0, y: 0, width: 24, height: 24))
            XCTAssertFalse(path.isEmpty, "\(icon) draws nothing")
            XCTAssertGreaterThanOrEqual(path.boundingRect.minY, -0.5, "\(icon) leaves the viewBox")
            XCTAssertLessThanOrEqual(path.boundingRect.maxY, 24.5, "\(icon) leaves the viewBox")
        }
        // The chevron at the end of every row has to flip in Arabic.
        XCTAssertTrue(CoreHubIcon.chevronForward.mirrorsInRTL)
    }
}
