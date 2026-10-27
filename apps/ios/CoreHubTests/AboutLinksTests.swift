@testable import CoreHub
import UIKit
import XCTest

/// About and the drawer point at where Core Hub lives (owner, 2026-10-27): the download page and
/// the repository, from packages/contracts' `PRODUCT_LINKS`, named in every language.
final class AboutLinksTests: XCTestCase {
    private let host = Bundle(for: AppModel.self)

    func testTheLinksAreTheProductsOwn() {
        XCTAssertEqual(Product.repositoryURL.absoluteString, "https://github.com/\(Product.repository)")
        XCTAssertEqual(Product.downloadPageURL.absoluteString, "https://twuijri.github.io/core-hub/")
    }

    func testAboutWritesAnAddressWithoutTheSchemeOrTheLastSlash() {
        XCTAssertEqual(AboutLinks.shown(Product.downloadPageURL), "twuijri.github.io/core-hub")
        XCTAssertEqual(AboutLinks.shown(Product.repositoryURL), "github.com/twuijri/core-hub")
    }

    func testAboutStartsWithThisAppThenTheConnectedHubOnlyWhenThereIsOne() {
        XCTAssertEqual(
            AboutLinks.versionRows(app: "1.1.10", hub: "1.1.8"),
            [
                AboutVersionRow(key: "app_version", labelKey: "about.app_version", value: "1.1.10"),
                AboutVersionRow(key: "connected_hub", labelKey: "about.connected_hub", value: "1.1.8"),
            ]
        )
        XCTAssertEqual(AboutLinks.versionRows(app: "1.1.10", hub: nil).map(\.key), ["app_version"])
    }

    func testEveryLanguageNamesTheLinks() {
        let keys = [
            "about.links", "about.download_page", "about.download_page_note",
            "about.repository", "about.repository_note", "shell.repository", "about.connected_hub",
        ]
        for language in [AppLanguage.en, .ar] {
            let l10n = L10n(language, bundle: host)
            for key in keys { XCTAssertNotEqual(l10n(key), key, "\(language) \(key)") }
        }
        XCTAssertEqual(L10n(.ar, bundle: host)("about.download_page"), "صفحة التحميل")
    }

    func testTheGitHubMarkIsInTheAssetCatalog() {
        XCTAssertNotNil(UIImage(named: "GitHubMark", in: host, compatibleWith: nil))
    }
}
