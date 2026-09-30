// Adding a provider, as the web's dialog: who it is for first (every profile, or this one), then a
// preset — by key, by signing in, a local one — or a custom OpenAI-compatible endpoint; the key is a
// secret field that can be shown, an address is asked where the preset needs one, and a loopback
// address on a hub in a container is called out. Signing in by device code is here too.
import CoreHubClient
import SwiftUI
import UIKit

struct AddProviderView: View {
    /// The providers already added: a preset that is not repeatable is offered once per scope.
    let added: [Provider]
    let done: (Provider?) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var scope: ProviderScope = .all

    var body: some View {
        AsyncContent(key: app.currentProfile) {
            let profile = app.currentProfile
            return try await app.api.call { try await ModelsAPI.modelsListProviderPresets(xHubProfile: profile, apiConfiguration: $0) }
        } content: { answer, _ in
            let presets = ModelLogic.offered(answer.items, added: added, scope: scope)
            List {
                Section {
                    Picker(l10n("models_page.for_whom"), selection: $scope) {
                        Text(l10n("models_page.scope_all")).tag(ProviderScope.all)
                        Text(l10n("models_page.scope_profile")).tag(ProviderScope.profile)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("provider.scope")
                } header: {
                    Text(l10n("models_page.for_whom"))
                } footer: {
                    Text(scope == .all ? l10n("models.scope_all_hint") : l10n("models.scope_profile_hint", ["profile": app.profileName(app.currentProfile)]))
                }
                ForEach([ProviderKind.llm, .stt, .tts], id: \.self) { kind in
                    let group = presets.filter { $0.kind == kind }
                    if !group.isEmpty {
                        Section(l10n("models_page.kind_\(kind.rawValue)")) {
                            ForEach(group, id: \.id) { preset in
                                NavigationLink {
                                    ProviderForm(preset: preset, scope: scope, host: answer.host, done: done)
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(preset.label)
                                        if preset.signIn {
                                            Text(l10n("models_page.by_sign_in")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                                        } else if preset.local {
                                            Text(l10n("models_page.local")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                                        } else if ModelLogic.keyOnFile(preset, scope: scope) {
                                            Text(l10n("models.key_on_file_short")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                                        }
                                    }
                                }
                                .accessibilityIdentifier("preset.\(preset.id)")
                            }
                        }
                    }
                }
                // Subscriptions signed in to through Core Hub's gateway (§143).
                SubscriptionVendorsSection(scope: scope, added: added, done: done)
                Section {
                    NavigationLink {
                        CustomProviderForm(scope: scope, host: answer.host, done: done)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(l10n("models.custom"))
                            Text(l10n("models.custom_hint")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                        }
                    }
                    .accessibilityIdentifier("preset.custom")
                }
            }
        }
        .navigationTitle(l10n("models_page.add"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button(l10n("common.close")) { done(nil) } } }
    }
}

/// The key as a secret, with the eye to show it; LTR monospace.
struct ProviderKeyField: View {
    let title: String
    @Binding var key: String
    @Environment(\.l10n) private var l10n
    @State private var shown = false

    var body: some View {
        HStack {
            Group {
                if shown {
                    TextField(title, text: $key).textInputAutocapitalization(.never).autocorrectionDisabled()
                } else {
                    SecureField(title, text: $key)
                }
            }
            .font(.system(size: FontSize.sizeSm, design: .monospaced))
            .environment(\.layoutDirection, .leftToRight)
            .accessibilityIdentifier("provider.key")
            Button { shown.toggle() } label: { LucideIcon(shown ? .eyeOff : .eye, size: 16) }
                .buttonStyle(.borderless)
                .accessibilityLabel(l10n(shown ? "models.hide_key" : "models.show_key"))
        }
    }
}

/// A base URL field, and the loopback warning under it when the hub is in a container.
private struct BaseURLField: View {
    let placeholder: String
    @Binding var url: String
    let host: ProviderHost?
    @Environment(\.l10n) private var l10n

    var body: some View {
        TextField(placeholder, text: $url)
            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
            .font(.system(size: FontSize.sizeSm, design: .monospaced))
            .environment(\.layoutDirection, .leftToRight)
            .accessibilityIdentifier("provider.url")
        if let suggestion = ModelLogic.loopbackSuggestion(url, host: host) {
            NoticeView(text: l10n("models.loopback", ["url": suggestion]), tone: .warning)
                .accessibilityIdentifier("provider.loopback")
        }
    }
}

private struct ProviderForm: View {
    let preset: ProviderPreset
    let scope: ProviderScope
    let host: ProviderHost?
    let done: (Provider?) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.openURL) private var openURL
    @State private var key = ""
    @State private var baseURL = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            if let error { NoticeView(text: error, tone: .danger) }
            Section {
                FactRow(label: l10n("models_page.for_whom"), value: scope == .all ? l10n("models_page.scope_all") : l10n("models.scope_only", ["profile": app.profileName(app.currentProfile)]))
            }
            if preset.signIn {
                NoticeView(text: l10n("models_page.sign_in_after"), tone: .info)
            } else {
                Section {
                    ProviderKeyField(title: l10n(ModelLogic.keyOptional(preset, scope: scope) ? "models_page.key_optional" : "models_page.key"), key: $key)
                    if let keys = preset.keysUrl, let url = URL(string: keys) {
                        Button(l10n("models_page.get_key")) { openURL(url) }
                    }
                } footer: {
                    if ModelLogic.keyOnFile(preset, scope: scope) { Text(l10n("models.key_on_file")) }
                }
            }
            if preset.baseUrlRequired || preset.baseUrl != nil {
                Section(l10n("models_page.base_url")) {
                    BaseURLField(placeholder: preset.baseUrlExample ?? "https://", url: $baseURL, host: host)
                }
            }
            if !preset.signIn {
                ProviderProbeSection(preset: preset.id, baseURL: baseURL, key: key)
            }
            Section {
                Button {
                    Task { await add() }
                } label: {
                    LucideLabel(l10n("models_page.add_do"), icon: .plus, size: 16).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).tint(Tone.accent)
                .disabled(busy || !ModelLogic.ready(preset, key: key, baseURL: baseURL, scope: scope))
                .accessibilityIdentifier("provider.add")
            }
        }
        .navigationTitle(preset.label)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if baseURL.isEmpty { baseURL = preset.baseUrl ?? "" } }
    }

    private func add() async {
        busy = true
        defer { busy = false }
        let profile = app.currentProfile, body = ModelLogic.create(preset, key: key, baseURL: baseURL, scope: scope)
        do {
            let provider = try await app.api.call { try await ModelsAPI.modelsCreateProvider(xHubProfile: profile, providerCreate: body, apiConfiguration: $0) }
            done(provider)
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }
}

/// A custom endpoint: what it does (chat or speech — asked, never guessed), a name, its address and
/// an optional key.
private struct CustomProviderForm: View {
    let scope: ProviderScope
    let host: ProviderHost?
    let done: (Provider?) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var kind: ProviderKind = .llm
    @State private var label = ""
    @State private var baseURL = ""
    @State private var key = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let draft = ModelLogic.custom(label: label, kind: kind, baseURL: baseURL, key: key, scope: scope)
        Form {
            if let error { NoticeView(text: error, tone: .danger) }
            Section(l10n("models.kind")) {
                Picker(l10n("models.kind"), selection: $kind) {
                    Text(l10n("models_page.kind_llm")).tag(ProviderKind.llm)
                    Text(l10n("models_page.kind_stt")).tag(ProviderKind.stt)
                    Text(l10n("models_page.kind_tts")).tag(ProviderKind.tts)
                }
                .pickerStyle(.segmented)
            }
            Section(l10n("models.label")) {
                TextField(l10n("models.label"), text: $label).accessibilityIdentifier("provider.label")
            }
            Section(l10n("models_page.base_url")) {
                BaseURLField(placeholder: "http://host:8000/v1", url: $baseURL, host: host)
            }
            Section {
                ProviderKeyField(title: l10n("models_page.key_optional"), key: $key)
            }
            ProviderProbeSection(preset: nil, baseURL: baseURL, key: key, kind: kind)
            Section {
                Button {
                    guard let draft else { return }
                    Task { await add(draft) }
                } label: {
                    LucideLabel(l10n("models_page.add_do"), icon: .plus, size: 16).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).tint(Tone.accent)
                .disabled(busy || draft == nil)
                .accessibilityIdentifier("provider.add")
            }
        }
        .navigationTitle(l10n("models.custom"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func add(_ body: ProviderCreate) async {
        busy = true
        defer { busy = false }
        let profile = app.currentProfile
        do {
            let provider = try await app.api.call { try await ModelsAPI.modelsCreateProvider(xHubProfile: profile, providerCreate: body, apiConfiguration: $0) }
            done(provider)
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }
}

/// A sign-in by device code: the code, the provider's page, waiting for the answer, and the outcome
/// in words — signed in, declined, ran out, or did not finish (with the runtime's reason); start again.
struct ProviderSignInView: View {
    let provider: Provider
    let done: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.openURL) private var openURL
    @State private var signIn: ProviderSignIn?
    @State private var error: String?
    @State private var attempt = 0
    /// The address a sign-in by link landed on, pasted back (§143).
    @State private var pasted = ""
    @State private var sending = false

    var body: some View {
        ScrollView {
            VStack(spacing: Space.s4) {
                if let error { NoticeView(text: error, tone: .danger) }
                if let signIn {
                    switch signIn.status {
                    case .approved:
                        NoticeView(text: l10n("models.sign_in_approved"), tone: .success)
                            .accessibilityIdentifier("signin.approved")
                    case .pending:
                        Text(l10n(signIn.acceptsCode ? "subscriptions.paste_steps" : "models_page.sign_in_steps")).font(.system(size: FontSize.sizeSm)).foregroundStyle(Tone.textMuted)
                        if let code = signIn.userCode {
                            Text(code)
                                .font(.system(size: FontSize.sizeXl, weight: .bold, design: .monospaced))
                                .textSelection(.enabled)
                                .environment(\.layoutDirection, .leftToRight)
                                .padding(Space.s4)
                                .frame(maxWidth: .infinity)
                                .background(Tone.surface2, in: RoundedRectangle(cornerRadius: Radius.md))
                                .accessibilityIdentifier("signin.code")
                            Button { UIPasteboard.general.string = code } label: { LucideLabel(l10n("models_page.copy"), icon: .copy, size: 16) }
                                .buttonStyle(.bordered)
                        }
                        if let url = URL(string: signIn.verificationUrl) {
                            Button {
                                openURL(url)
                            } label: {
                                LucideLabel(l10n("models_page.open_sign_in"), icon: .externalLink, size: 16).frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent).tint(Tone.accent)
                            .accessibilityIdentifier("signin.open")
                            Text(signIn.verificationUrl).font(.system(size: FontSize.sizeXs, design: .monospaced)).foregroundStyle(Tone.textMuted)
                                .textSelection(.enabled)
                                .environment(\.layoutDirection, .leftToRight)
                        }
                        if signIn.acceptsCode {
                            TextField(signIn.callbackHint ?? "http://localhost/…", text: $pasted)
                                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                                .font(.system(size: FontSize.sizeSm, design: .monospaced))
                                .environment(\.layoutDirection, .leftToRight)
                                .textFieldStyle(.roundedBorder)
                                .accessibilityIdentifier("signin.paste")
                            if let hint = signIn.callbackHint {
                                Text(l10n("subscriptions.paste_hint", ["start": hint])).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                            }
                            Button {
                                Task { await submit(signIn) }
                            } label: {
                                Text(l10n("subscriptions.paste_submit")).frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent).tint(Tone.accent)
                            .disabled(pasted.trimmingCharacters(in: .whitespaces).isEmpty || sending)
                            .accessibilityIdentifier("signin.paste_submit")
                        }
                        HStack { ProgressView(); Text(l10n("models_page.waiting_sign_in")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted) }
                    default:
                        NoticeView(text: ended(signIn), tone: .danger)
                            .accessibilityIdentifier("signin.ended")
                        Button(l10n("models.sign_in_retry")) { attempt += 1 }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("signin.retry")
                    }
                } else if error == nil {
                    ProgressView()
                } else {
                    Button(l10n("models.sign_in_retry")) { attempt += 1 }.buttonStyle(.bordered)
                }
            }
            .padding(Space.s4)
        }
        .navigationTitle(l10n("models_page.sign_in_to", ["name": provider.label]))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button(l10n("share.done")) { done() } } }
        .task(id: attempt) { await run() }
    }

    private func ended(_ signIn: ProviderSignIn) -> String {
        let head: String
        switch signIn.status {
        case .denied: head = l10n("models.sign_in_denied")
        case .expired: head = l10n("models.sign_in_expired")
        default: head = l10n("models_page.sign_in_failed")
        }
        return [head, signIn.error].compactMap { $0 }.joined(separator: " ")
    }

    /// The pasted address goes to the hub; the loop below keeps asking how the sign-in stands.
    private func submit(_ current: ProviderSignIn) async {
        sending = true
        defer { sending = false }
        let profile = app.currentProfile, id = provider.id, signInID = current.id
        let code = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            signIn = try await app.api.call {
                try await ModelsAPI.modelsCompleteProviderSignIn(
                    xHubProfile: profile, providerId: id, signInId: signInID,
                    modelsCompleteProviderSignInRequest: ModelsCompleteProviderSignInRequest(code: code), apiConfiguration: $0
                )
            }
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }

    private func run() async {
        let profile = app.currentProfile, id = provider.id
        signIn = nil
        error = nil
        do {
            var current = try await app.api.call { try await ModelsAPI.modelsStartProviderSignIn(xHubProfile: profile, providerId: id, apiConfiguration: $0) }
            signIn = current
            while !ModelLogic.settled(current) && !Task.isCancelled {
                try await Task.sleep(nanoseconds: 3_000_000_000)
                let signInID = current.id
                current = try await app.api.call { try await ModelsAPI.modelsGetProviderSignIn(xHubProfile: profile, providerId: id, signInId: signInID, apiConfiguration: $0) }
                signIn = current
            }
        } catch is CancellationError {
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }
}
