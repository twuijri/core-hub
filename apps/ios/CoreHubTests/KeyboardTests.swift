@testable import CoreHub
import SwiftUI
import UIKit
import XCTest

/// The keyboard gets out of the way (docs/changes/2026-09-26-twuijri-mobile-polish.md): the
/// drawer never opens over it, and a tap on the conversation puts it away.
@MainActor
final class KeyboardTests: XCTestCase {
    func testMovingTheDrawerPutsTheKeyboardAwayFirst() {
        var dismissed = 0
        let drawer = DrawerState(dismissKeyboard: { dismissed += 1 })

        drawer.set(true, animation: nil)
        XCTAssertTrue(drawer.isOpen)
        XCTAssertEqual(dismissed, 1)

        // Closing it too: the drawer's own search must not keep typing into nothing.
        drawer.set(false, animation: nil)
        XCTAssertFalse(drawer.isOpen)
        XCTAssertEqual(dismissed, 2)
    }

    func testDismissEndsEditingAnywhereInTheApp() throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        )
        let previous = scene.windows.first { $0.isKeyWindow }
        let window = UIWindow(windowScene: scene)
        let field = UITextField(frame: CGRect(x: 0, y: 0, width: 200, height: 40))
        window.addSubview(field)
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            previous?.makeKey()
        }

        XCTAssertTrue(field.becomeFirstResponder())
        Keyboard.dismiss()
        XCTAssertFalse(field.isFirstResponder)
    }
}

/// The drawer's header, sign-in and the new chat show the real Core Hub mark, not initials.
final class BrandMarkTests: XCTestCase {
    func testTheCatalogHoldsTheMarkAsATemplate() throws {
        let image = try XCTUnwrap(UIImage(named: "BrandMark"), "Assets.xcassets/BrandMark is missing")
        XCTAssertEqual(image.renderingMode, .alwaysTemplate)

        // Drawn, not blank: the square in the middle is filled and the ring around it is a hole
        // (CoreHubMark.tsx: the hole runs from x 203 to 290 of 895, the core from 290 to 603).
        let side = 179
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let rendered = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            image.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }
        let cgImage = try XCTUnwrap(rendered.cgImage)
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }
        XCTAssertTrue(drawn)
        func alpha(_ x: Int, _ y: Int) -> UInt8 { pixels[(y * side + x) * 4 + 3] }
        XCTAssertGreaterThan(alpha(89, 89), 200, "the core square is filled")
        XCTAssertLessThan(alpha(49, 89), 50, "the ring around it is open")
        XCTAssertGreaterThan(alpha(10, 89), 200, "the outer body is filled")
    }
}
