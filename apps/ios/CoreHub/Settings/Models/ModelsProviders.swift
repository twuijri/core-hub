// Models → Providers: every provider the hub added, by kind; a provider opens on its own page to be
// edited, tested, refreshed, signed in to, cleared of its key or removed, and to give its models
// display names. Where each list came from is said (§83): the provider's own list for the account,
// or a list kept in code with the reason.
import CoreHubClient
import SwiftUI

struct ModelsProvidersTab: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var providers: [Provider]?
    @State private var note: (text: String, tone: NoticeView.Kind)?
    @State private var adding = false
    @State private var signingIn: ProviderSignInTarget?
    @State private var deleting: Provider?
    @State private var refreshing = false

    var body: some View {
        List {
            if let note { NoticeView(text: note.text, tone: note.tone) }
            if app.isAdmin {
                Button { adding = true } label: { LucideLabel(l10n("models_page.add"), icon: .plus, size: 16) }
                    .accessibilityIdentifier("models.add")
                if let providers, providers.contains(where: { $0.catalogue.refreshable && $0.enabled }) {
                    Button { Task { await refreshAll(providers) } } label: { LucideLabel(l10n("models.refresh_all"), icon: .refreshCw, size: 16) }
                        .disabled(refreshing)
                        .accessibilityIdentifier("models.refresh_all")
                }
            }
            if let providers {
                if providers.isEmpty {
                    EmptyStateView(icon: .box, title: l10n("models_page.none"), message: l10n("models_page.none_body"))
                        .listRowBackground(Color.clear)
                }
                ForEach([ProviderKind.llm, .stt, .tts], id: \.self) { kind in
                    let group = providers.filter { $0.kind == kind }
                    if !group.isEmpty {
                        Section(l10n("models_page.kind_\(kind.rawValue)")) {
                            ForEach(group, id: \.id) { provider in
                                NavigationLink {
                                    ProviderDetailView(provider: provider) { Task { await load() } }
                                } label: {
                                    row(provider)
                                }
                                .accessibilityIdentifier("provider.\(provider.slug)")
                                .swipeActions {
                                    if app.isAdmin { Button(l10n("presets.delete"), role: .destructive) { deleting = provider } }
                                }
                            }
                        }
                    }
                }
                // What the agent runtime received (the web's Runtime card).
                RuntimeCardSection()
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .refreshable { await load() }
        .task(id: app.currentProfile) { await load() }
        .sheet(isPresented: $adding) {
            NavigationStack {
                AddProviderView(added: providers ?? []) { added in
                    adding = false
                    Task { await load() }
                    if let added, added.auth.kind == .oauth { signingIn = ProviderSignInTarget(provider: added) }
                }
            }
        }
        .sheet(item: $signingIn) { target in
            NavigationStack { ProviderSignInView(provider: target.provider) { signingIn = nil; Task { await load() } } }
        }
        .confirmDelete($deleting, name: { $0.label }, delete: { provider in
            let profile = app.currentProfile
            try await app.api.call { _ = try await ModelsAPI.modelsDeleteProvider(xHubProfile: profile, providerId: provider.id, apiConfiguration: $0) }
        }, deleted: { _ in
            Task { await load() }
        })
    }

    private func row(_ provider: Provider) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(provider.label).font(.system(size: FontSize.sizeMd, weight: .medium)).contentDirection(of: provider.label)
                Spacer()
                ProviderStatusPill(provider: provider)
            }
            Text("\(l10n(provider.scope == .profile ? "models_page.scope_profile" : "models_page.scope_all")) · \(l10n("models.count", ["count": String(provider.models.count)]))")
                .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
            if provider.catalogue.source == .fallback {
                Text(l10n("models.list_fallback_short")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.warningSoftText)
            }
        }
    }

    private func load() async {
        let profile = app.currentProfile
        do {
            providers = try await app.api.call { try await ModelsAPI.modelsListProviders(xHubProfile: profile, apiConfiguration: $0) }.items
        } catch {
            note = (HubFailure(error).describe(l10n), .danger)
        }
    }

    /// Asks every enabled provider that can be asked for its list again, then reads the lists back.
    private func refreshAll(_ list: [Provider]) async {
        refreshing = true
        defer { refreshing = false }
        let profile = app.currentProfile
        var failed: String?
        for provider in list where provider.catalogue.refreshable && provider.enabled {
            do {
                _ = try await app.api.call { try await ModelsAPI.modelsRefreshProvider(xHubProfile: profile, providerId: provider.id, apiConfiguration: $0) }
            } catch {
                failed = HubFailure(error).describe(l10n)
            }
        }
        if let failed {
            note = (failed, NoticeView.Kind.danger)
        } else {
            note = (l10n("models.refreshing"), NoticeView.Kind.info)
        }
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        await load()
    }
}

/// A provider's state in one word: needs a sign-in or a key, off, or on.
struct ProviderStatusPill: View {
    let provider: Provider
    @Environment(\.l10n) private var l10n

    var body: some View {
        if provider.auth.kind == .oauth && !provider.auth.signedIn {
            StatusPill(text: l10n("models_page.sign_in_needed"), kind: .warn)
        } else if provider.auth.kind == .apiKey && provider.apiKey == nil {
            StatusPill(text: l10n("models_page.key_needed"), kind: .warn)
        } else if provider.auth.kind == .oauth {
            StatusPill(text: l10n("models.signed_in"), kind: provider.enabled ? .good : .neutral)
        } else {
            StatusDot(kind: provider.enabled ? .good : .neutral, label: provider.enabled ? l10n("common.on") : l10n("common.off"))
        }
    }
}

/// A provider to sign in to, for `.sheet(item:)`.
struct ProviderSignInTarget: Identifiable {
    let provider: Provider
    var id: String { provider.id }
}

private struct AliasTarget: Identifiable {
    let model: Model
    var id: String { model.key }
}

/// One provider: what it is, where its list came from, what can be done with it, and its models.
struct ProviderDetailView: View {
    let changed: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var provider: Provider
    @State private var note: (text: String, tone: NoticeView.Kind)?
    @State private var busy = false
    @State private var editing = false
    @State private var signingIn = false
    @State private var deleting: Provider?
    @State private var clearingKey = false
    @State private var aliasing: AliasTarget?
    @State private var query = ""

    init(provider: Provider, changed: @escaping () -> Void) {
        _provider = State(initialValue: provider)
        self.changed = changed
    }

    var body: some View {
        List {
            if let note { NoticeView(text: note.text, tone: note.tone) }
            Section {
                HStack {
                    Text(provider.label).font(.system(size: FontSize.sizeLg, weight: .semibold)).contentDirection(of: provider.label)
                    Spacer()
                    ProviderStatusPill(provider: provider)
                }
                FactRow(label: l10n("models.for_whom"), value: provider.scope == .profile
                    ? l10n("models.scope_only", ["profile": app.profileName(provider.profile)])
                    : l10n("models_page.scope_all"))
                FactRow(label: l10n("models.kind"), value: l10n("models_page.kind_\(provider.kind.rawValue)"))
                FactRow(label: l10n("models_page.base_url"), value: provider.baseUrl ?? "—")
                if provider.auth.kind != .oauth {
                    FactRow(label: l10n("models.key"), value: l10n(provider.apiKey != nil ? "models.key_stored" : (provider.auth.kind == .apiKey ? "models.key_missing" : "models.key_not_needed")))
                }
                if let at = provider.catalogue.refreshedAt {
                    FactRow(label: l10n("models.refreshed_at"), value: at.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(app.language.locale)))
                }
            }
            ForEach(Array(ModelLogic.catalogueNotes(provider).enumerated()), id: \.offset) { _, item in
                catalogueNote(item)
            }
            // A subscription through Core Hub's gateway (§143): its accounts and their usage.
            if provider.subscription != nil { ProviderAccountsSection(providerId: provider.id) }
            if app.isAdmin { actions }
            modelsSection
        }
        .navigationTitle(provider.label)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .sheet(isPresented: $editing) { editSheet }
        .sheet(isPresented: $signingIn) {
            NavigationStack { ProviderSignInView(provider: provider) { signingIn = false; Task { await reload() } } }
        }
        .sheet(item: $aliasing) { target in aliasSheet(target.model) }
        .confirmDelete($deleting, name: { $0.label }, delete: { provider in
            let profile = app.currentProfile
            try await app.api.call { _ = try await ModelsAPI.modelsDeleteProvider(xHubProfile: profile, providerId: provider.id, apiConfiguration: $0) }
        }, deleted: { _ in
            changed()
            dismiss()
        })
        .confirmationDialog(l10n("models.clear_key_confirm", ["name": provider.label]), isPresented: $clearingKey, titleVisibility: .visible) {
            Button(l10n("models.clear_key"), role: .destructive) {
                Task { await patch(ProviderPatch(apiKey: "")) }
            }
        } message: {
            Text(l10n("models.clear_key_body"))
        }
    }

    @ViewBuilder
    private func catalogueNote(_ item: ModelLogic.CatalogueNote) -> some View {
        switch item {
        case .refreshing:
            HStack { ProgressView(); Text(l10n("models.refreshing")).font(.system(size: FontSize.sizeSm)).foregroundStyle(Tone.textMuted) }
        case .failed(let error):
            NoticeView(text: error, tone: .danger)
        case .fallback(let reason):
            NoticeView(text: l10n("models.list_fallback", ["reason": reason ?? "—"]), tone: .warning)
                .accessibilityIdentifier("provider.catalogue_fallback")
        case .fromAccount:
            NoticeView(text: l10n("models.list_from_account", ["provider": provider.label]), tone: .info)
                .accessibilityIdentifier("provider.catalogue_account")
        }
    }

    private var actions: some View {
        Section {
            Toggle(isOn: Binding(get: { provider.enabled }, set: { on in Task { await patch(ProviderPatch(enabled: on)) } })) {
                Text(l10n("models.enabled"))
            }
            .disabled(busy)
            .accessibilityIdentifier("provider.enabled")
            Button { editing = true } label: { LucideLabel(l10n("models.edit"), icon: .pencil, size: 16) }
                .accessibilityIdentifier("provider.edit")
            if provider.auth.kind == .oauth {
                Button { signingIn = true } label: {
                    LucideLabel(l10n(provider.auth.signedIn ? "models.sign_in_again" : "models_page.sign_in"), icon: .keyRound, size: 16)
                }
                .accessibilityIdentifier("provider.sign_in")
            }
            if provider.subscription == nil {
                Button { Task { await test() } } label: { LucideLabel(l10n("models.test"), icon: .activity, size: 16) }
                    .disabled(busy)
                    .accessibilityIdentifier("provider.test")
            }
            if provider.catalogue.refreshable {
                Button { Task { await refresh() } } label: { LucideLabel(l10n("models_page.refresh"), icon: .refreshCw, size: 16) }
                    .disabled(busy || provider.catalogue.status == .loading)
                    .accessibilityIdentifier("provider.refresh")
            }
            if provider.apiKey != nil {
                Button(role: .destructive) { clearingKey = true } label: { LucideLabel(l10n("models.clear_key"), icon: .x, size: 16) }
                    .accessibilityIdentifier("provider.clear_key")
            }
            Button(role: .destructive) { deleting = provider } label: { LucideLabel(l10n("presets.delete"), icon: .trash, size: 16) }
                .accessibilityIdentifier("provider.delete")
        }
    }

    private var modelsSection: some View {
        let q = query.trimmingCharacters(in: .whitespaces)
        let shown = provider.models.filter { q.isEmpty || $0.model.localizedCaseInsensitiveContains(q) || ($0.alias?.localizedCaseInsensitiveContains(q) ?? false) }
        return Section {
            if provider.models.count > 8 {
                TextField(l10n("models.search_models"), text: $query)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            if provider.models.isEmpty {
                Text(l10n("models.no_models")).font(.system(size: FontSize.sizeSm)).foregroundStyle(Tone.textMuted)
            }
            ForEach(shown, id: \.key) { model in
                Button {
                    if app.isAdmin { aliasing = AliasTarget(model: model) }
                } label: {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.alias ?? model.model).foregroundStyle(Tone.text)
                            if model.alias != nil {
                                Text(model.model).font(.system(size: FontSize.sizeXs, design: .monospaced)).foregroundStyle(Tone.textMuted)
                                    .environment(\.layoutDirection, .leftToRight)
                            }
                        }
                        Spacer()
                        if model.imageOnly == true { StatusPill(text: l10n("models.image_only"), kind: .neutral) }
                        if !model.visible { StatusPill(text: l10n("models.hidden"), kind: .neutral) }
                        if model.disabled { StatusPill(text: l10n("common.off"), kind: .neutral) }
                    }
                }
                .disabled(!app.isAdmin)
                .accessibilityIdentifier("provider.model.\(model.model)")
            }
        } header: {
            Text(l10n("models.models_of", ["count": String(provider.models.count)]))
        } footer: {
            if app.isAdmin && !provider.models.isEmpty { Text(l10n("models.alias_hint")) }
        }
    }

    private var editSheet: some View {
        FormSheet(
            title: l10n("models.edit_title", ["name": provider.label]),
            fields: [
                FormField(key: "label", label: l10n("models.label"), required: true),
                FormField(key: "base_url", label: l10n("models_page.base_url"), placeholder: "https://", mono: true),
                FormField(
                    key: "key", label: l10n(provider.auth.kind == .apiKey ? "models_page.key" : "models_page.key_optional"), kind: .secret,
                    help: l10n(provider.apiKey != nil ? "models.key_replace_hint" : "models.key_hint"), mono: true
                ),
            ],
            initial: ["label": provider.label, "base_url": provider.baseUrl ?? "", "key": ""],
            tag: "provider.form"
        ) { values in
            let body = ModelLogic.edit(provider, label: values["label"] ?? "", baseURL: values["base_url"] ?? "", key: values["key"] ?? "", enabled: provider.enabled)
            try await save(body)
        }
    }

    private func aliasSheet(_ model: Model) -> some View {
        FormSheet(
            title: l10n("models.alias_title"),
            fields: [FormField(key: "alias", label: l10n("models.alias"), help: l10n("models.alias_empty", ["model": model.model]), placeholder: model.model)],
            initial: ["alias": model.alias ?? ""],
            intro: model.model,
            tag: "model.alias"
        ) { values in
            let profile = app.currentProfile, id = provider.id, path = ModelLogic.pathModel(model.model), body = ModelLogic.alias(values["alias"] ?? "")
            _ = try await app.api.call { try await ModelsAPI.modelsPutModel(xHubProfile: profile, providerId: id, model: path, modelPatch: body, apiConfiguration: $0) }
            await reload()
            changed()
        }
    }

    private func save(_ body: ProviderPatch) async throws {
        let profile = app.currentProfile, id = provider.id
        provider = try await app.api.call { try await ModelsAPI.modelsUpdateProvider(xHubProfile: profile, providerId: id, providerPatch: body, apiConfiguration: $0) }
        changed()
    }

    private func patch(_ body: ProviderPatch) async {
        busy = true
        defer { busy = false }
        do {
            try await save(body)
            note = nil
        } catch {
            note = (HubFailure(error).describe(l10n), .danger)
        }
    }

    private func reload() async {
        let profile = app.currentProfile, id = provider.id
        do {
            let list = try await app.api.call { try await ModelsAPI.modelsListProviders(xHubProfile: profile, apiConfiguration: $0) }.items
            if let fresh = list.first(where: { $0.id == id }) { provider = fresh }
        } catch {
            note = (HubFailure(error).describe(l10n), .danger)
        }
    }

    private func test() async {
        busy = true
        defer { busy = false }
        note = (l10n("models.testing"), .info)
        let profile = app.currentProfile, id = provider.id
        do {
            let result = try await app.api.call { try await ModelsAPI.modelsTestProvider(xHubProfile: profile, providerId: id, apiConfiguration: $0) }
            if result.ok {
                note = (l10n("models_page.test_ok", ["ms": String(result.durationMs)]), NoticeView.Kind.success)
            } else {
                note = ("\(result.message ?? l10n("models.test_failed")) (\(result.durationMs) ms)", NoticeView.Kind.danger)
            }
            await reload()
        } catch {
            note = (HubFailure(error).describe(l10n), .danger)
        }
    }

    /// Asks the provider for its list again; the hub fetches it in the background, so the page reads
    /// the provider back until the list is no longer loading.
    private func refresh() async {
        busy = true
        defer { busy = false }
        let profile = app.currentProfile, id = provider.id
        do {
            _ = try await app.api.call { try await ModelsAPI.modelsRefreshProvider(xHubProfile: profile, providerId: id, apiConfiguration: $0) }
            note = (l10n("models.refreshing"), .info)
            for _ in 0..<10 {
                try await Task.sleep(nanoseconds: 1_500_000_000)
                await reload()
                if provider.catalogue.status != .loading { break }
            }
            if provider.catalogue.status == .error {
                note = nil
            } else {
                note = (l10n("models.refreshed", ["count": String(provider.models.count)]), NoticeView.Kind.success)
            }
            changed()
        } catch is CancellationError {
        } catch {
            note = (HubFailure(error).describe(l10n), .danger)
        }
    }
}
