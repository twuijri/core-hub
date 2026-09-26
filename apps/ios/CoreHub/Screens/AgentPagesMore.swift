// More of an agent's pages on the phone (B14): the settings edited in place with the Presets of
// contract decision §100 at the top, the coding agents' config files (§78) in a plain editor, and
// Channels with linking, unlinking and the senders waiting for approval. A platform linked by
// scanning a code (WhatsApp) cannot be scanned from this phone's own screen: the page says so and
// opens the web for another screen. Every call carries the profile the pages edit.
import CoreHubClient
import SwiftUI

/// A settings field's value, shown and typed.
enum SettingValues {
    /// `list` and `json` are read here and edited on the web.
    static func editable(_ field: SettingsField) -> Bool { field.kind != .list && field.kind != .json }

    static func text(_ value: JSONValue?) -> String? {
        guard let value else { return nil }
        if case .null = value { return nil }
        return JSONText.scalar(value)
    }

    /// What was typed as the field's value, or nil when it is not one; empty puts the default back.
    static func parse(_ field: SettingsField, _ typed: String) -> JSONValue? {
        let t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return .null }
        func inRange(_ n: Double) -> Bool { (field.min.map { n >= $0 } ?? true) && (field.max.map { n <= $0 } ?? true) }
        switch field.kind {
        case .integer:
            guard let n = Int(t), inRange(Double(n)) else { return nil }
            return .int(n)
        case .number:
            guard let n = Double(t.replacingOccurrences(of: ",", with: ".")), inRange(n) else { return nil }
            return .double(n)
        case .toggle:
            if t == "true" { return .bool(true) }
            if t == "false" { return .bool(false) }
            return nil
        case .choice:
            return field.options.contains { $0.value == t } ? .string(t) : nil
        default:
            return .string(typed)
        }
    }

    static func on(_ field: SettingsField) -> Bool {
        if case .bool(let on)? = field.value { return on }
        if case .bool(let on)? = field._default { return on }
        return false
    }
}

/// Which channels link from the phone, and what the link sends.
enum ChannelLinks {
    static func onPhone(_ platform: ChannelPlatform) -> Bool { platform.login != .qr }

    static func fields(_ platform: ChannelPlatform) -> [ChannelCredentialField] {
        if platform.login == .token && platform.credentials.isEmpty {
            return [ChannelCredentialField(key: "token", kind: .secret, _required: true)]
        }
        return platform.credentials
    }

    static func missing(_ platform: ChannelPlatform, _ typed: [String: String]) -> [String] {
        fields(platform).filter { $0._required && (typed[$0.key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }.map(\.key)
    }

    static func request(_ platform: ChannelPlatform, _ typed: [String: String], allowed: String) -> ChannelTokenLink {
        let users = allowed.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" }).map(String.init).filter { !$0.isEmpty }
        let allowedUsers = users.isEmpty || platform.allowedUsersKey == nil ? nil : users
        if platform.login == .token {
            let token = (typed["token"] ?? typed.values.first { !$0.isEmpty } ?? "").trimmingCharacters(in: .whitespaces)
            return ChannelTokenLink(token: token, allowedUsers: allowedUsers)
        }
        let credentials = typed.filter { !$0.value.trimmingCharacters(in: .whitespaces).isEmpty }.mapValues { $0.trimmingCharacters(in: .whitespaces) }
        return ChannelTokenLink(credentials: credentials, allowedUsers: allowedUsers)
    }

    static func account(_ channel: Channel) -> String? {
        guard let link = channel.link, link.linked else { return nil }
        let parts = [link.accountName, link.accountUsername.map { "@\($0)" }, link.accountPhone].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

// MARK: - Settings with presets

struct AgentSettingsEditPage: View {
    let agent: Agent
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var error: String?
    @State private var editing: (section: String, field: SettingsField)?
    @State private var typed = ""

    var body: some View {
        AsyncContent(key: app.currentProfile) {
            let profile = app.currentProfile
            return try await app.api.call { try await AgentsAPI.agentsGetSettings(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }
        } content: { settings, reload in
            List {
                AgentPresetsSection(agent: agent, applied: reload)
                if let error { NoticeView(text: error, tone: .danger) }
                ForEach(settings.sections, id: \.key) { section in
                    Section {
                        ForEach(section.fields, id: \.key) { field in
                            row(section: section.key, field: field, reload: reload)
                        }
                    } header: {
                        Text(text(section.title))
                    } footer: {
                        if let note = section.note { Text(text(note)) }
                    }
                }
            }
            .refreshable { reload() }
            .alert(editing.map { text($0.field.label) } ?? "", isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
                if let editing {
                    if editing.field.kind == .secret {
                        SecureField(editing.field.hint ?? "", text: $typed)
                    } else {
                        TextField(editing.field.hint ?? SettingValues.text(editing.field._default) ?? "", text: $typed)
                            .keyboardType(editing.field.kind == .integer ? .numberPad : editing.field.kind == .number ? .decimalPad : .default)
                    }
                    Button(l10n("common.save")) {
                        if let value = SettingValues.parse(editing.field, typed) {
                            let section = editing.section, key = editing.field.key
                            self.editing = nil
                            Task { await set(section: section, field: key, value: value, reload: reload) }
                        } else {
                            error = l10n("agent_settings.value_bad")
                            self.editing = nil
                        }
                    }
                    Button(l10n("common.cancel"), role: .cancel) { self.editing = nil }
                }
            } message: {
                Text(l10n("agent_settings.empty_is_default"))
            }
        }
    }

    @ViewBuilder
    private func row(section: String, field: SettingsField, reload: @escaping () -> Void) -> some View {
        switch field.kind {
        case .toggle:
            Toggle(isOn: Binding(get: { SettingValues.on(field) }, set: { value in
                Task { await set(section: section, field: field.key, value: .bool(value), reload: reload) }
            })) {
                label(field)
            }
        case .choice:
            Picker(selection: Binding(get: { SettingValues.text(field.value ?? field._default) ?? "" }, set: { value in
                Task { await set(section: section, field: field.key, value: .string(value), reload: reload) }
            })) {
                ForEach(field.options, id: \.value) { option in
                    Text(option.labels.map(text) ?? option.label).tag(option.value)
                }
            } label: {
                label(field)
            }
        default:
            if SettingValues.editable(field) {
                Button {
                    typed = field.kind == .secret ? "" : (SettingValues.text(field.value) ?? "")
                    editing = (section, field)
                } label: {
                    HStack {
                        label(field)
                        Spacer()
                        Text(field.kind == .secret ? (SettingValues.text(field.value) == nil ? "—" : "••••") : (SettingValues.text(field.value) ?? SettingValues.text(field._default).map { "(\($0))" } ?? "—"))
                            .foregroundStyle(Tone.textMuted)
                            .lineLimit(1)
                    }
                }
                .accessibilityIdentifier("setting.\(section).\(field.key)")
            } else {
                FactRow(label: text(field.label), value: SettingValues.text(field.value) ?? "—")
            }
        }
    }

    private func label(_ field: SettingsField) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(text(field.label)).foregroundStyle(Tone.text)
            if let help = field.help {
                Text(text(help)).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted).lineLimit(3)
            }
        }
    }

    private func text(_ localized: LocalizedText) -> String { app.language == .ar ? localized.ar : localized.en }

    private func set(section: String, field: String, value: JSONValue, reload: @escaping () -> Void) async {
        let profile = app.currentProfile
        do {
            _ = try await app.api.call {
                try await AgentsAPI.agentsUpdateSettings(xHubProfile: profile, agentId: agent.id, agentSettingsPatch: AgentSettingsPatch(section: section, values: [field: value]), apiConfiguration: $0)
            }
            error = nil
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
        reload()
    }
}

/// Presets (§100): saved bundles of this agent's settings in the profile.
struct AgentPresetsSection: View {
    let agent: Agent
    let applied: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var presets: [AgentPreset]?
    @State private var note: (text: String, tone: NoticeView.Kind)?
    @State private var naming = false
    @State private var name = ""
    @State private var deleting: AgentPreset?

    var body: some View {
        Section(l10n("presets.title")) {
            if let note { NoticeView(text: note.text, tone: note.tone) }
            if let presets {
                if presets.isEmpty {
                    Text(l10n("presets.none")).font(.system(size: FontSize.sizeSm)).foregroundStyle(Tone.textMuted)
                }
                ForEach(presets, id: \.id) { preset in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(preset.name).contentDirection(of: preset.name)
                            if let last = preset.lastActivatedAt {
                                Text(l10n("presets.last", ["time": last.shortText(app.language)])).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                            }
                        }
                        Spacer()
                        Button(l10n("presets.activate")) { Task { await activate(preset) } }
                            .buttonStyle(ChipButtonStyle())
                            .accessibilityIdentifier("preset.\(preset.id).activate")
                    }
                    .swipeActions {
                        Button(role: .destructive) { deleting = preset } label: { Text(l10n("presets.delete")) }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
            Button {
                name = ""
                naming = true
            } label: {
                LucideLabel(l10n("presets.save_current"), icon: .plus, size: 16)
            }
            .accessibilityIdentifier("preset.new")
        }
        .task(id: app.currentProfile) { await load() }
        .alert(l10n("presets.save_current"), isPresented: $naming) {
            TextField(l10n("presets.name"), text: $name)
            Button(l10n("common.save")) { Task { await save() } }
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            Button(l10n("common.cancel"), role: .cancel) {}
        }
        .confirmationDialog(deleting.map { l10n("presets.delete_confirm", ["name": $0.name]) } ?? "", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button(l10n("presets.delete"), role: .destructive) {
                if let preset = deleting { Task { await remove(preset) } }
                deleting = nil
            }
        }
    }

    private func load() async {
        let profile = app.currentProfile
        presets = (try? await app.api.call { try await AgentsAPI.agentsListPresets(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }.items) ?? []
    }

    private func save() async {
        let profile = app.currentProfile, write = AgentPresetWrite(name: name.trimmingCharacters(in: .whitespaces))
        do {
            _ = try await app.api.call { try await AgentsAPI.agentsCreatePreset(xHubProfile: profile, agentId: agent.id, agentPresetWrite: write, apiConfiguration: $0) }
            note = nil
        } catch {
            note = (HubFailure(error).describe(l10n), .danger)
        }
        await load()
    }

    private func activate(_ preset: AgentPreset) async {
        let profile = app.currentProfile
        do {
            let result = try await app.api.call { try await AgentsAPI.agentsActivatePreset(xHubProfile: profile, agentId: agent.id, presetId: preset.id, apiConfiguration: $0) }
            note = result.skipped.isEmpty ? (l10n("presets.applied"), .success) : (l10n("presets.skipped", ["count": String(result.skipped.count)]), .warning)
            applied()
        } catch {
            note = (HubFailure(error).describe(l10n), .danger)
        }
        await load()
    }

    private func remove(_ preset: AgentPreset) async {
        let profile = app.currentProfile
        _ = try? await app.api.call { try await AgentsAPI.agentsDeletePreset(xHubProfile: profile, agentId: agent.id, presetId: preset.id, apiConfiguration: $0) }
        await load()
    }
}

// MARK: - Config files

struct AgentConfigFilesPage: View {
    let agent: Agent
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var chosen: String?

    var body: some View {
        AsyncContent(key: agent.id) {
            let profile = app.currentProfile
            return try await app.api.call { try await AgentsAPI.agentsListConfigFiles(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }.items
        } content: { files, _ in
            if files.isEmpty {
                EmptyStateView(icon: .fileCog, title: l10n("common.empty"))
            } else {
                let key = chosen ?? files[0].key
                VStack(spacing: Space.s2) {
                    if files.count > 1 {
                        Picker(l10n("nav.config_files"), selection: Binding(get: { key }, set: { chosen = $0 })) {
                            ForEach(files, id: \.key) { file in
                                Text(app.language == .ar ? file.label.ar : file.label.en).tag(file.key)
                            }
                        }
                        .pickerStyle(.segmented)
                        .padding(.horizontal, Space.s4)
                    }
                    ConfigFileEditor(agent: agent, fileKey: key).id(key)
                }
            }
        }
    }
}

struct ConfigFileEditor: View {
    let agent: Agent
    let fileKey: String
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var file: ConfigFile?
    @State private var text = ""
    @State private var note: (text: String, tone: NoticeView.Kind)?
    @State private var changedElsewhere = false
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            if let file {
                Text(file.path).font(.system(size: FontSize.sizeXs, design: .monospaced)).foregroundStyle(Tone.textMuted).lineLimit(2)
                NoticeView(text: l10n("config.shared"), tone: .info)
                if !file.exists { Text(l10n("config.new_file")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted) }
                if let note { NoticeView(text: note.text, tone: note.tone) }
                if changedElsewhere {
                    Button(l10n("config.reload")) { Task { await load() } }.buttonStyle(.bordered)
                }
                TextEditor(text: $text)
                    .font(file.language == .markdown ? .system(size: FontSize.sizeSm) : .system(size: FontSize.sizeSm, design: .monospaced))
                    .environment(\.layoutDirection, file.language == .markdown ? (ContentDirection.of(text) ?? .leftToRight) : .leftToRight)
                    .autocorrectionDisabled(file.language != .markdown)
                    .textInputAutocapitalization(.never)
                    .padding(Space.s2)
                    .background(Tone.surface, in: RoundedRectangle(cornerRadius: Radius.md))
                    .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(Tone.border, lineWidth: 0.5))
                    .accessibilityIdentifier("config.editor")
                HStack {
                    Button {
                        Task { await save(file) }
                    } label: {
                        LucideLabel(l10n("common.save"), icon: .check, size: 16)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Tone.accent)
                    .disabled(busy || text == (file.content ?? ""))
                    .accessibilityIdentifier("config.save")
                    Button(l10n("config.revert")) { text = file.content ?? "" }
                        .disabled(text == (file.content ?? ""))
                }
            } else if let note {
                NoticeView(text: note.text, tone: note.tone)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, Space.s4)
        .padding(.bottom, Space.s3)
        .task { await load() }
    }

    private func load() async {
        let profile = app.currentProfile, key = fileKey
        do {
            let fresh = try await app.api.call { try await AgentsAPI.agentsGetConfigFile(xHubProfile: profile, agentId: agent.id, fileKey: key, apiConfiguration: $0) }
            file = fresh
            text = fresh.content ?? ""
            changedElsewhere = false
            note = nil
        } catch {
            note = (HubFailure(error).describe(l10n), .danger)
        }
    }

    private func save(_ current: ConfigFile) async {
        busy = true
        defer { busy = false }
        let profile = app.currentProfile, write = ConfigFileWrite(content: text, revision: current.revision)
        do {
            let saved = try await app.api.call { try await AgentsAPI.agentsPutConfigFile(xHubProfile: profile, agentId: agent.id, fileKey: current.key, configFileWrite: write, apiConfiguration: $0) }
            file = saved
            text = saved.content ?? text
            note = (l10n("config.saved"), .success)
        } catch {
            let failure = HubFailure(error)
            if failure.status == 409 && failure.code == "changed" {
                changedElsewhere = true
                note = (l10n("config.changed"), .danger)
            } else {
                note = (failure.describe(l10n), .danger)
            }
        }
    }
}

// MARK: - Channels

struct AgentChannelsLinkPage: View {
    let agent: Agent
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.openURL) private var openURL
    @State private var channels: [Channel]?
    @State private var pairing: PairingList?
    @State private var error: String?
    @State private var linking = false
    @State private var unlinking: Channel?

    var body: some View {
        List {
            if let error { NoticeView(text: error, tone: .danger) }
            Section(l10n("channels.linked")) {
                let linked = (channels ?? []).filter { $0.configured || $0.link?.linked == true }
                if channels == nil { ProgressView().frame(maxWidth: .infinity) }
                if channels != nil && linked.isEmpty {
                    Text(l10n("channels.none")).font(.system(size: FontSize.sizeSm)).foregroundStyle(Tone.textMuted)
                }
                ForEach(linked, id: \.platform) { channel in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(channel.label)
                            if let line = ChannelLinks.account(channel) ?? channel.error {
                                Text(line).font(.system(size: FontSize.sizeXs)).foregroundStyle(channel.error != nil ? Tone.danger : Tone.textMuted)
                            }
                        }
                        Spacer()
                        StatusDot(kind: channel.status == .online ? .good : channel.status == .error ? .bad : .neutral, label: l10n("channels.status_\(channel.status.rawValue)"))
                    }
                    .swipeActions {
                        Button(role: .destructive) { unlinking = channel } label: { Text(l10n("channels.unlink")) }
                    }
                    .contextMenu {
                        Button(role: .destructive) { unlinking = channel } label: { Text(l10n("channels.unlink")) }
                    }
                    .accessibilityIdentifier("channel.\(channel.platform)")
                }
                Button {
                    linking = true
                } label: {
                    LucideLabel(l10n("channels.link"), icon: .link, size: 16)
                }
                .accessibilityIdentifier("channels.link")
            }
            if let pairing {
                Section(l10n("channels.waiting")) {
                    if pairing.pending.isEmpty {
                        Text(l10n("channels.nobody_waiting")).font(.system(size: FontSize.sizeSm)).foregroundStyle(Tone.textMuted)
                    }
                    ForEach(pairing.pending, id: \.requestId) { request in
                        VStack(alignment: .leading, spacing: Space.s1) {
                            Text(request.userName ?? request.userId)
                            Text("\(request.platform) · \(request.requestedAt.shortText(app.language))").font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                            HStack {
                                Button(l10n("workflows.approve")) { Task { await act { _ = try await AgentsAPI.agentsApprovePairing(xHubProfile: $0, agentId: agent.id, platform: request.platform, requestId: request.requestId, apiConfiguration: $1) } } }
                                    .buttonStyle(.borderedProminent).tint(Tone.accent)
                                Button(l10n("workflows.deny"), role: .destructive) { Task { await act { try await AgentsAPI.agentsDenyPairing(xHubProfile: $0, agentId: agent.id, platform: request.platform, requestId: request.requestId, apiConfiguration: $1) } } }
                                    .buttonStyle(.bordered)
                            }
                        }
                        .accessibilityIdentifier("pairing.\(request.requestId)")
                    }
                }
                if !pairing.approved.isEmpty {
                    Section(l10n("channels.approved")) {
                        ForEach(pairing.approved, id: \.userId) { sender in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(sender.userName ?? sender.userId)
                                    Text(sender.platform).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                                }
                                Spacer()
                                Button(l10n("channels.revoke")) { Task { await act { try await AgentsAPI.agentsRevokePairing(xHubProfile: $0, agentId: agent.id, platform: sender.platform, userId: sender.userId, apiConfiguration: $1) } } }
                                    .buttonStyle(ChipButtonStyle(quiet: true))
                            }
                        }
                    }
                }
            }
        }
        .refreshable { await load() }
        .task(id: app.currentProfile) { await load() }
        .sheet(isPresented: $linking, onDismiss: { Task { await load() } }) {
            NavigationStack { ChannelLinkSheet(agent: agent, openWeb: openWeb) }
        }
        .confirmationDialog(unlinking.map { l10n("channels.unlink_confirm", ["platform": $0.label]) } ?? "", isPresented: Binding(get: { unlinking != nil }, set: { if !$0 { unlinking = nil } }), titleVisibility: .visible) {
            Button(l10n("channels.unlink"), role: .destructive) {
                if let channel = unlinking {
                    Task { await act { _ = try await AgentsAPI.agentsUnlinkChannel(xHubProfile: $0, agentId: agent.id, platform: channel.platform, apiConfiguration: $1) } }
                }
                unlinking = nil
            }
        }
    }

    private func openWeb() {
        guard let hub = app.credentials?.hubURL, let path = AppRoutes.routes[.agentChannels]?.replacingOccurrences(of: ":agentId", with: agent.id),
              let url = URL(string: hub.absoluteString + path) else { return }
        openURL(url)
    }

    private func load() async {
        let profile = app.currentProfile
        do {
            channels = try await app.api.call { try await AgentsAPI.agentsListChannels(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }.items
            pairing = try? await app.api.call { try await AgentsAPI.agentsListPairing(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }
            error = nil
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }

    private func act(_ operation: @escaping (String, CoreHubClientAPIConfiguration) async throws -> Void) async {
        let profile = app.currentProfile
        do {
            try await app.api.call { try await operation(profile, $0) }
            error = nil
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
        await load()
    }
}

struct ChannelLinkSheet: View {
    let agent: Agent
    let openWeb: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        AsyncContent(key: agent.id) {
            let profile = app.currentProfile
            return try await app.api.call { try await AgentsAPI.agentsListChannelPlatforms(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }.items
        } content: { platforms, _ in
            List(platforms, id: \.platform) { platform in
                NavigationLink {
                    ChannelLinkForm(agent: agent, platform: platform, openWeb: openWeb, done: { dismiss() })
                } label: {
                    HStack {
                        LucideIcon(ChannelLinks.onPhone(platform) ? .link : .qrCode, size: 16).foregroundStyle(Tone.textMuted)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(platform.label)
                            if !ChannelLinks.onPhone(platform) {
                                Text(l10n("channels.qr_short")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                            }
                        }
                    }
                }
                .accessibilityIdentifier("platform.\(platform.platform)")
            }
        }
        .navigationTitle(l10n("channels.link"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button(l10n("common.close")) { dismiss() } }
        }
    }
}

struct ChannelLinkForm: View {
    let agent: Agent
    let platform: ChannelPlatform
    let openWeb: () -> Void
    let done: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.openURL) private var openURL
    @State private var typed: [String: String] = [:]
    @State private var allowed = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            if !ChannelLinks.onPhone(platform) {
                // A code shown on this screen cannot be scanned by this phone's own camera.
                Section {
                    NoticeView(text: l10n("channels.qr_body", ["platform": platform.label]), tone: .info)
                    Button {
                        openWeb()
                    } label: {
                        LucideLabel(l10n("channels.open_web"), icon: .externalLink, size: 16)
                    }
                    .accessibilityIdentifier("platform.web")
                }
            } else {
                if let error { NoticeView(text: error, tone: .danger) }
                Section {
                    ForEach(ChannelLinks.fields(platform), id: \.key) { field in
                        let binding = Binding(get: { typed[field.key] ?? "" }, set: { typed[field.key] = $0 })
                        let label = field.key == "token" ? l10n("channels.bot_token") : field.key + (field._required ? " *" : "")
                        Group {
                            if field.kind == .secret {
                                SecureField(label, text: binding)
                            } else {
                                TextField(label, text: binding)
                                    .keyboardType(field.kind == .email ? .emailAddress : field.kind == .url ? .URL : field.kind == .number ? .numberPad : .default)
                            }
                        }
                        .font(.system(size: FontSize.sizeSm, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("link.\(field.key)")
                    }
                    if platform.allowedUsersKey != nil {
                        TextField(l10n("channels.allowed"), text: $allowed)
                            .textInputAutocapitalization(.never)
                    }
                } footer: {
                    if platform.pairs { Text(l10n("channels.pairs_note")) }
                }
                Section {
                    Button {
                        Task { await link() }
                    } label: {
                        LucideLabel(l10n("channels.link_do"), icon: .link, size: 16).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Tone.accent)
                    .disabled(busy || !ChannelLinks.missing(platform, typed).isEmpty)
                    .accessibilityIdentifier("link.submit")
                    if let docs = platform.docsUrl, let url = URL(string: docs) {
                        Button(l10n("channels.docs")) { openURL(url) }
                    }
                }
            }
        }
        .navigationTitle(platform.label)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func link() async {
        busy = true
        defer { busy = false }
        let profile = app.currentProfile, request = ChannelLinks.request(platform, typed, allowed: allowed), name = platform.platform
        do {
            _ = try await app.api.call { try await AgentsAPI.agentsLinkChannel(xHubProfile: profile, agentId: agent.id, platform: name, channelTokenLink: request, apiConfiguration: $0) }
            done()
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }
}
