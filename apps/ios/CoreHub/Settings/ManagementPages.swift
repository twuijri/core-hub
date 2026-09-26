// The Management section (`settingsManagement`) and the Tools (`settingsTools`) of Settings.
import CoreHubClient
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

struct ModelsPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: app.currentProfile) {
            let profile = app.currentProfile
            async let providers = app.api.call { try await ModelsAPI.modelsListProviders(xHubProfile: profile, apiConfiguration: $0) }
            async let defaults = app.api.call { try await ModelsAPI.modelsGetDefaults(xHubProfile: profile, apiConfiguration: $0) }
            return try await (providers.items, defaults)
        } content: { loaded, reload in
            List {
                Section {
                    FactRow(label: l10n("models.default"), value: loaded.1._default.map { $0.model } ?? "—")
                    Text(l10n("models.edit_on_web")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                }
                Section(l10n("models.providers")) {
                    if loaded.0.isEmpty { EmptyRow(icon: .box) }
                    ForEach(loaded.0, id: \.id) { provider in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(provider.label).font(.system(size: FontSize.sizeMd, weight: .medium))
                                Spacer()
                                StatusPill(text: provider.enabled ? l10n("common.on") : l10n("common.off"), kind: provider.enabled ? .good : .neutral)
                            }
                            Text(l10n("models.count", ["count": String(provider.models.count)]))
                                .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                        }
                    }
                }
            }
            .refreshable { reload() }
        }
    }
}

/// Device connections: `App` makes a pairing another phone scans; `Devices` (admin) lists the
/// paired devices — the hub's `devices` module says itself whether it is built.
struct DeviceConnectionsPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var tab = 0

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                Text(l10n("devices.tab_app")).tag(0)
                // Everyone sees their own devices; an admin sees everyone's (the hub decides).
                Text(l10n("devices.tab_devices")).tag(1)
            }
            .pickerStyle(.segmented)
            .padding(Space.s3)
            if tab == 0 {
                PairingMaker()
            } else {
                // The cards of #149: state, last active, push; rename, test the push, remove.
                DeviceCardsList()
            }
        }
    }
}

/// Makes a pairing and shows its QR code, the code and the link, for another phone.
struct PairingMaker: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var pairing: Pairing?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(spacing: Space.s3) {
                Text(l10n("devices.pair_hint")).font(.system(size: FontSize.sizeSm)).foregroundStyle(Tone.textMuted)
                if let error { NoticeView(text: error, tone: .danger) }
                if let pairing {
                    if let image = QRImage.make(pairing.qrPayload) {
                        Image(uiImage: image)
                            .interpolation(.none)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: 240)
                            .padding(Space.s3)
                            .background(Color.white, in: RoundedRectangle(cornerRadius: Radius.md))
                            .accessibilityLabel(l10n("devices.qr"))
                    }
                    Text(pairing.code)
                        .font(.system(size: FontSize.sizeXl, weight: .bold, design: .monospaced))
                        .textSelection(.enabled)
                        .environment(\.layoutDirection, .leftToRight)
                    Text(l10n("devices.expires", ["time": pairing.expiresAt.shortText(app.language)]))
                        .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                }
                Button {
                    Task { await make() }
                } label: {
                    LucideLabel(pairing == nil ? l10n("devices.make_pairing") : l10n("devices.new_pairing"), icon: .qrCode)
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
            }
            .padding(Space.s4)
        }
    }

    private func make() async {
        busy = true
        defer { busy = false }
        do {
            pairing = try await app.api.call { try await AuthAPI.authCreatePairing(pairingCreate: PairingCreate(), apiConfiguration: $0) }
            error = nil
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }
}

enum QRImage {
    static func make(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

struct KnowledgePage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: app.currentProfile) {
            let profile = app.currentProfile
            return try await app.api.call { try await KnowledgeAPI.knowledgeListItems(xHubProfile: profile, limit: 100, apiConfiguration: $0) }.items
        } content: { items, reload in
            List {
                if items.isEmpty { EmptyRow(icon: .bookOpen) }
                ForEach(items, id: \.id) { item in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(item.title ?? item.kind.rawValue).font(.system(size: FontSize.sizeSm, weight: .medium))
                            Spacer()
                            StatusPill(text: l10n("knowledge.kind_\(item.kind.rawValue)"))
                        }
                        if let content = item.content {
                            Text(content).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted).lineLimit(3)
                                .contentDirection(of: content)
                        }
                    }
                }
            }
            .refreshable { reload() }
        }
    }
}

/// Usage: the hub's usage report for the profile, shown as the hub writes it. Logs and
/// Performance read their own live endpoints (LiveTools.swift, contract decision §51).
struct AuditPage: View {
    let kind: AuditAPI.Kind_auditGetReport
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: "\(kind.rawValue)/\(app.currentProfile)") {
            let profile = app.currentProfile
            return try await app.api.call {
                try await AuditAPI.auditGetReport(kind: kind, xHubProfile: profile, apiConfiguration: $0)
            }
        } content: { report, reload in
            List {
                FactRow(label: l10n("audit.period"), value: "\(report.period.from.shortText(app.language)) – \(report.period.to.shortText(app.language))")
                ForEach(report.data.keys.sorted(), id: \.self) { key in
                    JSONOutline(label: key, value: report.data[key] ?? .null)
                }
            }
            .refreshable { reload() }
        }
    }
}

/// Theme: the look this phone uses (local) and the one the hub keeps for the person.
struct ThemePage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        Form {
            Section {
                Picker(l10n("nav.theme"), selection: Binding(get: { app.theme }, set: { app.theme = $0 })) {
                    ForEach(ThemeChoice.allCases) { choice in
                        Label { Text(l10n(choice.labelKey)) } icon: { Image(lucide: choice.icon) }.tag(choice)
                    }
                }
                .pickerStyle(.inline)
            }
        }
    }
}

struct WorkspacesPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var slug = ""
    @State private var name = ""
    @State private var error: String?

    var body: some View {
        AsyncContent(key: "profiles") {
            try await app.api.call { try await AuthAPI.authListProfiles(apiConfiguration: $0) }.items
        } content: { profiles, reload in
            Form {
                if let error { NoticeView(text: error, tone: .danger) }
                Section {
                    ForEach(profiles, id: \.id) { profile in
                        HStack {
                            Text(profile.name)
                            Spacer()
                            Text(profile.slug).font(.system(size: FontSize.sizeXs, design: .monospaced)).foregroundStyle(Tone.textMuted)
                        }
                    }
                }
                Section(l10n("workspaces.new")) {
                    TextField(l10n("workspaces.name"), text: $name)
                    TextField(l10n("workspaces.slug"), text: $slug)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .environment(\.layoutDirection, .leftToRight)
                    Button(l10n("workspaces.create")) { Task { await create(reload) } }
                        .disabled(slug.isEmpty || name.isEmpty)
                }
            }
        }
    }

    private func create(_ reload: @escaping () -> Void) async {
        let request = ProfileCreate(slug: slug.lowercased(), name: name)
        do {
            _ = try await app.api.call { try await AuthAPI.authCreateProfile(profileCreate: request, apiConfiguration: $0) }
            slug = ""
            name = ""
            error = nil
            await app.refreshAccount()
            reload()
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }
}

struct UpdatesPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: "updates") {
            let version = app.appVersion
            return try await app.api.call {
                try await UpdatesAPI.updatesCheck(platform: .ios, channel: .stable, currentVersion: version, apiConfiguration: $0)
            }
        } content: { check, reload in
            Form {
                Section { Text(l10n("settings.global_note")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted) }
                Section {
                    FactRow(label: l10n("about.app_version"), value: app.appVersion)
                    if let release = check.release, check.available {
                        FactRow(label: l10n("updates.available"), value: release.version)
                        Text(app.language == .ar ? release.notes.ar : release.notes.en)
                            .font(.system(size: FontSize.sizeSm))
                    } else {
                        Text(check.reason == .notConfigured ? l10n("updates.not_configured") : l10n("updates.up_to_date"))
                            .foregroundStyle(Tone.textMuted)
                    }
                    Button(l10n("updates.check")) { reload() }
                }
            }
        }
    }
}

/// What is installed on this hub (`plugins.list`); an agent's own plugins live under the agent.
struct HubPluginsPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: "plugins") {
            try await app.api.call { try await PluginsAPI.pluginsList(apiConfiguration: $0) }.items
        } content: { plugins, reload in
            List {
                if plugins.isEmpty { EmptyRow(icon: .puzzle) }
                ForEach(plugins, id: \.id) { plugin in
                    HStack {
                        Text(plugin.name)
                        Spacer()
                        Text(plugin.version).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                    }
                }
            }
            .refreshable { reload() }
        }
    }
}
