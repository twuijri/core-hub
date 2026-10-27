// Settings → About.
import CoreHubClient
import SwiftUI

struct AboutPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        // A hub that does not answer leaves this app's own version on the page, without its lines.
        AsyncContent(key: "meta") {
            try? await app.api.call { try await MetaAPI.metaGet(apiConfiguration: $0) }
        } content: { meta, _ in
            Form {
                // This app first, then the hub it is connected to, only when it is (owner,
                // 2026-10-27), as on the web and Android.
                Section(l10n.productName) {
                    ForEach(AboutLinks.versionRows(app: app.appVersion, hub: meta?.serverVersion)) { row in
                        FactRow(label: l10n(row.labelKey), value: row.value)
                            .accessibilityIdentifier("about.\(row.key)")
                    }
                    if let meta {
                        FactRow(label: l10n("about.hub"), value: meta.name)
                        FactRow(label: l10n("about.contract_version"), value: meta.contractVersion)
                    }
                }
                // Where Core Hub lives (owner, 2026-10-27), as on the web and Android: the
                // download page and the repository, for somebody who forgot.
                Section(l10n("about.links")) {
                    AboutLinkRow(
                        title: l10n("about.download_page"), note: l10n("about.download_page_note"),
                        url: Product.downloadPageURL
                    ) { LucideIcon(.download, size: 18) }
                        .accessibilityIdentifier("about.download_page")
                    AboutLinkRow(
                        title: l10n("about.repository"), note: l10n("about.repository_note"),
                        url: Product.repositoryURL
                    ) { GitHubMarkIcon(size: 18) }
                        .accessibilityIdentifier("about.repository")
                }
            }
        }
    }
}

/// One link in About: its icon, its name, a line on what is there, and where it goes.
private struct AboutLinkRow<Icon: View>: View {
    let title: String
    let note: String
    let url: URL
    @ViewBuilder let icon: () -> Icon

    var body: some View {
        Link(destination: url) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
                icon().foregroundStyle(Tone.textMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(Tone.text)
                    Text(note)
                        .font(.system(size: FontSize.sizeXs))
                        .foregroundStyle(Tone.textMuted)
                    Text(AboutLinks.shown(url))
                        .font(.system(size: FontSize.sizeXs))
                        .foregroundStyle(Tone.textFaint)
                        .environment(\.layoutDirection, .leftToRight)
                }
            }
            .font(.system(size: FontSize.sizeSm))
        }
    }
}

/// One of About's version lines.
struct AboutVersionRow: Identifiable, Equatable {
    let key: String
    let labelKey: String
    let value: String
    var id: String { key }
}

enum AboutLinks {
    /// About's first lines: this app's version, then the connected hub's when there is one.
    static func versionRows(app: String, hub: String?) -> [AboutVersionRow] {
        var rows = [AboutVersionRow(key: "app_version", labelKey: "about.app_version", value: app)]
        if let hub { rows.append(AboutVersionRow(key: "connected_hub", labelKey: "about.connected_hub", value: hub)) }
        return rows
    }

    /// How About writes an address: without `https://` and a trailing slash.
    static func shown(_ url: URL) -> String {
        var text = url.absoluteString
        if text.hasPrefix("https://") { text.removeFirst("https://".count) }
        if text.hasSuffix("/") { text.removeLast() }
        return text
    }
}

extension PhonePage {
    static let about = PhonePage(.about) { _ in AboutPage() }
}
