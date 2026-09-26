// The Settings tabs (`settingsTabs`): the person's own settings, each its own page.
import CoreHubClient
import SwiftUI

struct AccountPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var name = ""
    @State private var current = ""
    @State private var fresh = ""
    @State private var note: (String, NoticeView.Kind)?

    var body: some View {
        AsyncContent(key: "me") {
            try await app.api.call { try await AuthAPI.authGetMe(apiConfiguration: $0) }
        } content: { me, reload in
            Form {
                if let note { NoticeView(text: note.0, tone: note.1) }
                Section {
                    FactRow(label: l10n("login.username"), value: me.username)
                    FactRow(label: l10n("account.role"), value: l10n("account.role_\(me.role.rawValue)"))
                    TextField(l10n("account.display_name"), text: $name)
                        .onAppear { if name.isEmpty { name = me.displayName } }
                    Button(l10n("common.save")) { Task { await saveName(reload) } }
                        .disabled(name.isEmpty || name == me.displayName)
                }
                Section(l10n("account.password")) {
                    SecureField(l10n("account.current_password"), text: $current)
                    SecureField(l10n("account.new_password"), text: $fresh)
                    Button(l10n("account.change_password")) { Task { await changePassword() } }
                        .disabled(current.isEmpty || fresh.count < 8)
                }
            }
        }
    }

    private func saveName(_ reload: @escaping () -> Void) async {
        let patch = UserSelfPatch(displayName: name)
        do {
            _ = try await app.api.call { try await AuthAPI.authUpdateMe(userSelfPatch: patch, apiConfiguration: $0) }
            note = (l10n("common.saved"), .success)
            await app.refreshAccount()
            reload()
        } catch {
            note = (HubFailure(error).describe(l10n), .danger)
        }
    }

    private func changePassword() async {
        let change = PasswordChange(currentPassword: current, newPassword: fresh)
        do {
            try await app.api.call { try await AuthAPI.authChangePassword(passwordChange: change, apiConfiguration: $0) }
            current = ""
            fresh = ""
            note = (l10n("account.password_changed"), .success)
        } catch {
            note = (HubFailure(error).describe(l10n), .danger)
        }
    }
}

struct UsersPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: "users") {
            try await app.api.call { try await AuthAPI.authListUsers(limit: 200, apiConfiguration: $0) }.items
        } content: { users, reload in
            List {
                Section { Text(l10n("settings.global_note")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted) }
                ForEach(users, id: \.id) { user in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(user.displayName).font(.system(size: FontSize.sizeMd, weight: .medium))
                            Spacer()
                            StatusPill(text: l10n("account.role_\(user.role.rawValue)"))
                            if user.status == .disabled { StatusPill(text: l10n("users.disabled"), kind: .bad) }
                        }
                        Text("@\(user.username) · \(user.profiles.joined(separator: ", "))")
                            .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                    }
                }
            }
            .refreshable { reload() }
        }
    }
}

struct WebhooksPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var notes: [String: String] = [:]

    var body: some View {
        AsyncContent(key: "webhooks") {
            try await app.api.call { try await NotifyAPI.notifyListWebhooks(apiConfiguration: $0) }.items
        } content: { hooks, reload in
            List {
                if hooks.isEmpty { EmptyRow(icon: .webhook) }
                ForEach(hooks, id: \.id) { hook in
                    VStack(alignment: .leading, spacing: Space.s1) {
                        HStack {
                            Text(hook.name).font(.system(size: FontSize.sizeMd, weight: .medium))
                            Spacer()
                            StatusPill(text: hook.enabled ? l10n("common.on") : l10n("common.off"), kind: hook.enabled ? .good : .neutral)
                        }
                        Text(hook.url).font(.system(size: FontSize.sizeXs, design: .monospaced)).foregroundStyle(Tone.textMuted)
                            .lineLimit(1).truncationMode(.middle)
                            .environment(\.layoutDirection, .leftToRight)
                        if let note = notes[hook.id] { NoticeView(text: note, tone: .info) }
                        Button(l10n("webhooks.test")) { Task { await test(hook) } }
                            .font(.system(size: FontSize.sizeSm))
                    }
                }
            }
            .refreshable { reload() }
        }
    }

    private func test(_ hook: Webhook) async {
        do {
            _ = try await app.api.call { try await NotifyAPI.notifyTestWebhook(webhookId: hook.id, apiConfiguration: $0) }
            notes[hook.id] = l10n("webhooks.test_sent")
        } catch {
            notes[hook.id] = HubFailure(error).describe(l10n)
        }
    }
}

/// Display: the person's preferences the hub keeps (`auth.me.preferences`), plus the app's
/// own language.
struct DisplayPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: "preferences") {
            try await app.api.call { try await AuthAPI.authGetPreferences(apiConfiguration: $0) }
        } content: { preferences, reload in
            PreferencesForm(initial: preferences, saved: reload) { draft in
                Section {
                    Picker(l10n("shell.language"), selection: Binding(get: { app.language }, set: { app.language = $0 })) {
                        ForEach(AppLanguage.allCases) { Text(l10n("shell.language_\($0.rawValue)")).tag($0) }
                    }
                    Picker(l10n("display.link_target"), selection: draft.linkTarget) {
                        Text(l10n("display.link_in_app")).tag(Preferences.LinkTarget.inApp)
                        Text(l10n("display.link_browser")).tag(Preferences.LinkTarget.browser)
                    }
                    Picker(l10n("display.busy_input"), selection: draft.busyInputMode) {
                        Text(l10n("display.busy_queue")).tag(Preferences.BusyInputMode.queue)
                        Text(l10n("display.busy_next")).tag(Preferences.BusyInputMode.next)
                        Text(l10n("display.busy_interrupt")).tag(Preferences.BusyInputMode.interrupt)
                    }
                }
                Section {
                    Toggle(l10n("display.show_reasoning"), isOn: draft.showReasoning)
                    Toggle(l10n("display.show_tool_calls"), isOn: draft.showToolCalls)
                    Toggle(l10n("display.compact"), isOn: draft.compact)
                    VStack(alignment: .leading) {
                        Text(l10n("display.text_scale", ["percent": String(Int((draft.wrappedValue.textScale * 100).rounded()))]))
                        Slider(value: draft.textScale, in: 0.85...1.45, step: 0.05)
                    }
                }
            }
        }
    }
}

/// Edits a copy of the preferences and saves the whole document (`auth.setPreferences`).
struct PreferencesForm<Fields: View>: View {
    let initial: Preferences
    let saved: () -> Void
    @ViewBuilder let fields: (Binding<Preferences>) -> Fields
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var draft: Preferences?
    @State private var note: (String, NoticeView.Kind)?

    var body: some View {
        Form {
            if let note { NoticeView(text: note.0, tone: note.1) }
            fields(Binding(get: { draft ?? initial }, set: { draft = $0 }))
            Section {
                Button(l10n("common.save")) { Task { await save() } }
                    .disabled(draft == nil || draft == initial)
            }
        }
    }

    private func save() async {
        guard let draft else { return }
        do {
            _ = try await app.api.call { try await AuthAPI.authSetPreferences(preferences: draft, apiConfiguration: $0) }
            note = (l10n("common.saved"), .success)
            saved()
        } catch {
            note = (HubFailure(error).describe(l10n), .danger)
        }
    }
}

struct NotificationsPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: "notifications") {
            async let preferences = app.api.call { try await AuthAPI.authGetPreferences(apiConfiguration: $0) }
            async let notices = app.api.call { try await NotifyAPI.notifyListNotices(limit: 30, apiConfiguration: $0) }
            return try await (preferences, notices)
        } content: { loaded, reload in
            PreferencesForm(initial: loaded.0, saved: reload) { draft in
                // Whether this phone can show them at all comes first.
                PushStatusSection()
                Section {
                    Toggle(l10n("notifications.on_complete"), isOn: draft.notifyOnComplete)
                    Toggle(l10n("notifications.on_approval"), isOn: draft.notifyOnApproval)
                    Toggle(l10n("notifications.sound"), isOn: draft.soundOnComplete)
                }
                Section(l10n("notifications.inbox", ["count": String(loaded.1.unreadCount)])) {
                    if loaded.1.items.isEmpty { EmptyRow(icon: .bell) }
                    ForEach(loaded.1.items, id: \.id) { notice in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(notice.title).font(.system(size: FontSize.sizeSm, weight: notice.readAt == nil ? .semibold : .regular))
                                .contentDirection(of: notice.title)
                            if let body = notice.body {
                                Text(body).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted).lineLimit(2)
                                    .contentDirection(of: body)
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Privacy: what can act as you — app tokens (paired phones among them) and devices.
struct PrivacyPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var error: String?

    var body: some View {
        AsyncContent(key: "tokens") {
            try await app.api.call { try await AuthAPI.authListAppTokens(apiConfiguration: $0) }.items
        } content: { tokens, reload in
            List {
                if let error { NoticeView(text: error, tone: .danger) }
                Section(l10n("privacy.app_tokens")) {
                    if tokens.isEmpty { EmptyRow(icon: .shieldCheck) }
                    ForEach(tokens, id: \.id) { token in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(token.name).font(.system(size: FontSize.sizeSm, weight: .medium))
                            Text(token.scopes.map(\.rawValue).joined(separator: ", "))
                                .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                            if let used = token.lastUsedAt {
                                Text(l10n("privacy.last_used", ["time": used.shortText(app.language)]))
                                    .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textFaint)
                            }
                        }
                        .swipeActions {
                            Button(l10n("privacy.revoke"), role: .destructive) { Task { await revoke(token, reload) } }
                        }
                    }
                }
            }
            .refreshable { reload() }
        }
    }

    private func revoke(_ token: AppToken, _ reload: @escaping () -> Void) async {
        do {
            try await app.api.call { try await AuthAPI.authRevokeAppToken(tokenId: token.id, apiConfiguration: $0) }
            error = nil
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
        reload()
    }
}

/// This device: which hub this phone talks to and as whom. Part 3 adds voice input, dictation
/// language and spoken replies here.
struct ThisDevicePage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        Form {
            Section(l10n("device.connection")) {
                FactRow(label: l10n("login.hub_url"), value: app.credentials?.hubURL.absoluteString ?? "—")
                FactRow(label: l10n("device.signed_in_as"), value: app.credentials.map { "\($0.displayName) (@\($0.username))" } ?? "—")
                FactRow(label: l10n("device.how"), value: app.credentials?.kind == .device ? l10n("device.paired") : l10n("device.password"))
                HStack {
                    Text(l10n("device.realtime")).foregroundStyle(Tone.textMuted)
                    Spacer()
                    ConnectionDot()
                }
                .font(.system(size: FontSize.sizeSm))
            }
            ThisDeviceExtras()
            Section {
                Button(l10n("nav.sign_out"), role: .destructive) { Task { await app.signOut() } }
            }
        }
    }
}

struct AboutPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: "meta") {
            try await app.api.call { try await MetaAPI.metaGet(apiConfiguration: $0) }
        } content: { meta, _ in
            Form {
                Section(l10n.productName) {
                    FactRow(label: l10n("about.hub"), value: meta.name)
                    FactRow(label: l10n("about.server_version"), value: meta.serverVersion)
                    FactRow(label: l10n("about.contract_version"), value: meta.contractVersion)
                    FactRow(label: l10n("about.app_version"), value: app.appVersion)
                    FactRow(label: l10n("about.source"), value: "github.com/\(Product.repository)")
                }
            }
        }
    }
}
