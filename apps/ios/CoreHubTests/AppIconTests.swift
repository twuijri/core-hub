import XCTest

/// The app icon (Resources/Assets.xcassets/AppIcon, from scripts/icons/build-icons.mjs): App Store
/// Connect refuses a build without one. actool writes CFBundleIcons into the built Info.plist only
/// when `ASSETCATALOG_COMPILER_APPICON_NAME` names a set it compiled, so this reads the host app's
/// Info.plist rather than trusting project.yml.
final class AppIconTests: XCTestCase {
    func testTheBuiltAppNamesItsIcon() throws {
        let icons = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any])
        let primary = try XCTUnwrap(icons["CFBundlePrimaryIcon"] as? [String: Any])
        XCTAssertEqual(primary["CFBundleIconName"] as? String, "AppIcon")
    }
}
