import SwiftUI

/// History (web `HistoryView.vue`): search across titles and message text
/// with snippets, "All profiles" filter, category groups, the archived list
/// with Unarchive, batch selection (archive / unarchive / delete / move) and
/// the per-session ⋯ menu.
struct ChatsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var sessions: [SessionSummary] = []
    @State private var results: [SessionSearchResult] = []
    @State private var categories: [SessionCategory] = []
    @State private var search = ""
    @State private var showArchived = false
    @State private var loading = true
    @State private var selection = SessionBatchSelection()
    @State private var renaming: SessionSummary?
    @State private var renameText = ""
    @State private var deleting: SessionSummary?
    @State private var managing: SessionSummary?
    @State private var managingCategories = false
    @State private var creatingSession = false
    @State private var exportURL: URL?
    @State private var pageLimit = 100

    private var actions: SessionActions { SessionActions(store: store) }
    private var searching: Bool { !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var visible: [SessionSummary] { sessions.filter { $0.archived == showArchived } }

    var body: some View {
        VStack(spacing: 0) {
            filterBar
            list
            if selection.active {
                SessionBatchBar(
                    selectedCount: selection.ids.count,
                    archiveCount: selection.archiveTargets(in: sessions).count,
                    unarchiveCount: selection.unarchiveTargets(in: sessions).count,
                    categories: categories,
                    onArchive: { Task { await actions.batchArchive(selection.archiveTargets(in: sessions), archived: true); selection.clear() } },
                    onUnarchive: { Task { await actions.batchArchive(selection.unarchiveTargets(in: sessions), archived: false); selection.clear() } },
                    onMove: { category in Task { await actions.batchAssign(selection.selected(in: sessions), category: category); selection.clear() } },
                    onDelete: { Task { await actions.batchDelete(selection.selected(in: sessions)); selection.clear() } },
                    onCancel: { selection.clear() }
                )
            }
        }
        .background(CoreHubTokens.Palette.bgPrimary)
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .task(id: "\(store.sessionListProfile ?? "*")|\(search)|\(showArchived)|\(store.sessionListVersion)|\(pageLimit)") {
            if searching { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            await load()
        }
        .sheet(isPresented: $managingCategories) { NavigationStack { SessionCategoriesView(categories: $categories) }.environmentObject(store) }
        .sheet(isPresented: $creatingSession) { NewCodingSessionView(categories: categories).environmentObject(store) }
        .sheet(item: $managing) { item in SessionManagementView(session: item, categories: categories).environmentObject(store) }
        .sheet(item: $exportURL) { url in ExportShareSheet(url: url) }
        .alert("Rename conversation", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $renameText)
            Button("Save") { if let renaming { Task { await actions.rename(renaming, to: renameText) } }; renaming = nil }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .confirmationDialog("Delete conversation?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { session in
            Button("Delete", role: .destructive) { Task { await actions.delete(session) } }
            Button("Cancel", role: .cancel) { deleting = nil }
        } message: { session in Text(session.title) }
    }

    // MARK: Filter bar

    private var filterBar: some View {
        VStack(spacing: 8) {
            SearchBar(text: $search)
            HStack(spacing: 8) {
                profileMenu
                Button { showArchived.toggle(); selection.clear() } label: {
                    HStack(spacing: 5) {
                        Image(systemName: showArchived ? "tray.full.fill" : "archivebox").font(.system(size: 12))
                        Text(showArchived ? "Archived" : "Active").font(CoreHubTokens.Typography.sidebarTabFont)
                    }
                }
                .buttonStyle(CoreHubPillButtonStyle(prominent: showArchived))
                Spacer(minLength: 0)
                Text(searching ? String(localized: "\(results.count) matches") : String(localized: "\(visible.count) conversations"))
                    .font(CoreHubTokens.Typography.metaFont)
                    .foregroundStyle(CoreHubTokens.Palette.textMuted)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    private var profileMenu: some View {
        Menu {
            Button { store.setAllProfilesSessions(true) } label: { if store.allProfilesSessions { Label("All profiles", systemImage: "checkmark") } else { Text("All profiles") } }
            Divider()
            ForEach(store.profiles) { profile in
                Button { store.chooseProfile(profile.name); store.setAllProfilesSessions(false) } label: {
                    if !store.allProfilesSessions && store.selectedProfile == profile.name { Label(profile.name, systemImage: "checkmark") } else { Text(profile.name) }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "line.3.horizontal.decrease.circle").font(.system(size: 12))
                Text(store.allProfilesSessions ? String(localized: "All profiles") : store.selectedProfile).font(CoreHubTokens.Typography.sidebarTabFont).lineLimit(1)
            }
        }
        .buttonStyle(CoreHubPillButtonStyle())
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { withAnimation(CoreHubTokens.Motion.quick) { selection.active.toggle(); if !selection.active { selection.ids = [] } } } label: {
                Image(systemName: selection.active ? "checkmark.circle.fill" : "checkmark.circle")
            }
            .accessibilityLabel(selection.active ? "Exit selection" : "Select conversations")
            Menu {
                Button { managingCategories = true } label: { Label("Manage categories", systemImage: "folder.badge.gearshape") }
                Button { creatingSession = true } label: { Label("New conversation with agent…", systemImage: "square.and.pencil") }
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            } label: { CoreHubIconView(icon: .more, size: 20).foregroundStyle(CoreHubTokens.Palette.textPrimary) }
            .accessibilityLabel("More")
        }
    }

    // MARK: List

    @ViewBuilder private var list: some View {
        if loading && sessions.isEmpty && results.isEmpty {
            ProgressView("Loading conversations…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if searching {
            searchList
        } else {
            groupedList
        }
    }

    private var searchList: some View {
        List {
            if results.isEmpty {
                EmptyState(icon: "magnifyingglass", title: "No matches", detail: "Nothing matched in titles or messages.")
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            ForEach(results) { result in
                VStack(alignment: .leading, spacing: 2) {
                    row(result.session)
                    if !result.snippet.isEmpty {
                        DirectionalText(text: result.snippet, font: CoreHubTokens.Typography.metaFont, color: CoreHubTokens.Palette.textMuted, lineLimit: 2)
                            .padding(.horizontal, CoreHubTokens.Layout.sessionRowHorizontal)
                            .padding(.bottom, 6)
                    }
                }
                .listRowInsets(EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 6))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await load() }
    }

    private var groupedList: some View {
        let groups = SessionGrouping.groups(
            sessions: visible, categories: categories,
            pinnedIDs: store.browserPrefs.pinnedIDs(profile: store.selectedProfile),
            recentCount: store.browserPrefs.recentCount,
            labels: .init(recent: String(localized: "Recent"), pinned: String(localized: "Pinned"), uncategorized: String(localized: "Uncategorized"))
        )
        return List {
            if visible.isEmpty {
                EmptyState(icon: showArchived ? "archivebox" : "bubble.left.and.bubble.right", title: showArchived ? "No archived conversations" : "No conversations", detail: showArchived ? "Archived conversations appear here." : "Start a conversation with your agent.")
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            ForEach(groups.filter { showArchived ? $0.kind != .recent && $0.kind != .pinned : true }) { group in
                Section {
                    ForEach(group.sessions) { session in
                        row(session)
                            .listRowInsets(EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 6))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                } header: { GroupHeaderLabel(title: group.label, count: group.count) }
            }
            if !showArchived && sessions.count >= pageLimit {
                Button("Load more") { pageLimit += 100 }.frame(maxWidth: .infinity).font(CoreHubTokens.Typography.sidebarTabFont)
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await load() }
    }

    private func row(_ session: SessionSummary) -> some View {
        let pinned = store.browserPrefs.isPinned(session.id, profile: session.profile)
        return HStack(spacing: 4) {
            if selection.active {
                Button { selection.toggle(session.id) } label: { BatchSelectionMark(selected: selection.ids.contains(session.id)) }.buttonStyle(.plain)
            }
            SessionRowView(
                session: session,
                categoryLabel: categories.first { $0.id == session.categoryID }?.name,
                pinned: pinned,
                unread: store.browserPrefs.unreadIDs().contains(session.id),
                selected: store.selectedSession?.id == session.id,
                profileAvatar: store.profiles.first { $0.name == session.profile }?.avatar,
                time: SessionTimeFormatter.string(for: session.updatedAt, locale: store.locale),
                open: { if selection.active { selection.toggle(session.id) } else { store.open(session) } },
                requestDelete: { deleting = session }
            )
        }
        .contextMenu {
            SessionContextMenu(
                session: session, pinned: pinned, categories: categories,
                onRename: { renameText = session.title; renaming = session },
                onPin: { store.browserPrefs.togglePin(session.id, profile: session.profile); store.sessionsChanged() },
                onAssign: { category in Task { await actions.assign(session, category: category) } },
                onArchive: { Task { await actions.archive(session, archived: !session.archived) } },
                onExport: { mode, ext in Task { exportURL = await actions.export(session, mode: mode, ext: ext) } },
                onSettings: { managing = session },
                onDelete: { deleting = session }
            )
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { deleting = session } label: { Label("Delete", systemImage: "trash") }
            if session.source != "global_agent" {
                Button { Task { await actions.archive(session, archived: !session.archived) } } label: { Label(session.archived ? "Unarchive" : "Archive", systemImage: session.archived ? "tray.and.arrow.up" : "archivebox") }.tint(CoreHubTokens.Palette.warning)
            }
        }
    }

    // MARK: Data

    private func load() async {
        loading = true
        defer { loading = false }
        async let categoryRequest = store.api.sessionCategories()
        do {
            if searching {
                results = try await store.api.searchSessionMatches(search, profile: store.sessionListProfile)
            } else if showArchived {
                sessions = try await store.api.historySessionGroups(profile: store.sessionListProfile, limit: pageLimit)
            } else {
                sessions = try await store.api.sessions(profile: store.sessionListProfile, limit: pageLimit)
            }
            categories = try await categoryRequest
        } catch {
            store.errorMessage = error.localizedDescription
        }
    }
}

/// Session settings sheet: model + reasoning effort, workspace, category,
/// push notification, usage, export and the current context (web
/// `SessionSettings` + context drawer).
struct SessionManagementView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let session: SessionSummary
    let categories: [SessionCategory]
    var reload: (() async -> Void)? = nil

    @State private var workspace = ""
    @State private var categoryID = 0
    @State private var push = true
    @State private var reasoning = ""
    @State private var model = ""
    @State private var provider = ""
    @State private var models: [ModelOption] = []
    @State private var folders: [String] = []
    @State private var usage: SessionUsage?
    @State private var exportURL: URL?
    @State private var saveState: SaveState = .idle
    @State private var showingContext = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Model") {
                    Picker("Model", selection: $model) {
                        Text("Session default").tag("")
                        ForEach(models) { option in Text(option.name).tag(option.id) }
                    }
                    .onChange(of: model) { _, value in provider = models.first { $0.id == value }?.provider ?? "" }
                    Picker("Reasoning effort", selection: $reasoning) {
                        Text("Default").tag("")
                        ForEach(ReasoningEffortOption.allCases) { option in Text(option.label).tag(option.rawValue) }
                    }
                }
                Section("Workspace") {
                    if !folders.isEmpty {
                        Picker("Recent workspaces", selection: $workspace) { Text("No workspace").tag(""); ForEach(folders, id: \.self) { Text($0).tag($0) } }
                    }
                    TextField("Workspace path", text: $workspace).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Section("Organization") {
                    Picker("Category", selection: $categoryID) { Text("No category").tag(0); ForEach(categories) { Text($0.name).tag($0.id) } }
                    Toggle("Push completion notification", isOn: $push)
                }
                Section("Usage") {
                    if let usage {
                        LabeledContent("Input tokens", value: ContextUsageFormat.tokens(usage.inputTokens))
                        LabeledContent("Output tokens", value: ContextUsageFormat.tokens(usage.outputTokens))
                    } else {
                        LabeledContent("Input tokens", value: ContextUsageFormat.tokens(session.inputTokens))
                        LabeledContent("Output tokens", value: ContextUsageFormat.tokens(session.outputTokens))
                    }
                    if session.messageCount > 0 { LabeledContent("Messages", value: "\(session.messageCount)") }
                    Button("Show current context") { showingContext = true }
                }
                Section("Export") {
                    Button("Prepare full JSON") { Task { exportURL = await SessionActions(store: store).export(session, mode: "full", ext: "json") } }
                    Button("Prepare compressed text") { Task { exportURL = await SessionActions(store: store).export(session, mode: "compressed", ext: "txt") } }
                    if let exportURL { ShareLink(item: exportURL) { Label("Share export", systemImage: "square.and.arrow.up") } }
                }
                Section {
                    SaveButton(title: String(localized: "Save"), state: saveState) { Task { await save() } }
                }
            }
            .navigationTitle("Session settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $showingContext) { SessionContextView(session: session).environmentObject(store) }
            .task { await load() }
        }
    }

    private func load() async {
        workspace = session.workspace
        categoryID = session.categoryID ?? 0
        push = session.pushEnabled
        reasoning = session.reasoningEffort
        model = session.model
        provider = session.provider
        async let modelRequest = store.api.models(profile: session.profile.nilIfEmpty ?? store.selectedProfile)
        async let folderRequest = store.api.workspaceFolders()
        async let usageRequest = store.api.sessionUsage(session.id)
        models = (try? await modelRequest) ?? []
        folders = (try? await folderRequest) ?? []
        usage = try? await usageRequest
    }

    private func save() async {
        saveState = .saving
        do {
            if workspace != session.workspace { try await store.api.setSessionWorkspace(session.id, workspace: workspace.nilIfEmpty) }
            if (categoryID > 0 ? categoryID : nil) != session.categoryID { try await store.api.setSessionCategory(session.id, categoryID: categoryID > 0 ? categoryID : nil) }
            if push != session.pushEnabled { try await store.api.setSessionPush(session.id, enabled: push) }
            if !model.isEmpty && model != session.model { try await store.api.setSessionModel(session.id, model: model, provider: provider.nilIfEmpty) }
            if reasoning != session.reasoningEffort { try await store.api.setSessionReasoningEffort(session.id, effort: reasoning) }
            saveState = .saved
            store.notify(String(localized: "Session updated"))
            store.sessionsChanged()
            if let reload { await reload() }
        } catch {
            saveState = .failed(error.localizedDescription)
        }
    }
}

/// `GET /sessions/{id}/context` — the messages the model currently sees.
struct SessionContextView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let session: SessionSummary
    @State private var messages: [SessionContextMessage] = []
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                if loading { ProgressView().frame(maxWidth: .infinity) }
                else if messages.isEmpty { Text("The context is empty.").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted) }
                ForEach(messages) { message in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(message.role == "user" ? "You" : "Assistant")
                            .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.author, weight: .medium))
                            .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                        DirectionalText(text: message.content, font: CoreHubTokens.Typography.sidebarTabFont, lineLimit: 12)
                    }
                    .padding(.vertical, 4)
                    .listRowBackground(CoreHubTokens.Palette.bgCard)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Current context")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task {
                messages = (await store.attempt { try await store.api.sessionContext(session.id, profile: session.profile.nilIfEmpty) }) ?? []
                loading = false
            }
        }
    }
}

/// Save button with inline state: spinner while saving, "Saved" or the error.
struct SaveButton: View {
    let title: String
    let state: SaveState
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: action) {
                HStack(spacing: 8) {
                    if state.isSaving { ProgressView().controlSize(.small) }
                    Text(title)
                    Spacer(minLength: 0)
                    SaveStateLabel(state: state)
                }
            }
            .disabled(state.isSaving)
            if case let .failed(message) = state {
                Text(message).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.error)
            }
        }
    }
}

/// "Saving…" / "Saved" / "Failed" text for any setting.
struct SaveStateLabel: View {
    let state: SaveState

    var body: some View {
        switch state {
        case .idle: EmptyView()
        case .saving: Text("Saving…").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted)
        case .saved: Label("Saved", systemImage: "checkmark.circle.fill").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.success)
        case .failed: Label("Failed", systemImage: "exclamationmark.triangle.fill").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.error)
        }
    }
}

struct NewCodingSessionView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let categories: [SessionCategory]
    @State private var agent = "hermes"; @State private var profile = ""; @State private var mode = "scoped"; @State private var workspace = ""; @State private var categoryID = 0; @State private var apiMode = "codex_responses"; @State private var baseURL = ""; @State private var apiKey = ""; @State private var pushEnabled = true
    private var isCoding: Bool { AgentIdentity.canonicalID(agent) != "hermes" }
    var body: some View { NavigationStack { Form { Section("Agent") { Picker("Runtime", selection: $agent) { ForEach(["hermes", "ekko-agent", "claude-code", "codex", "pi"], id: \.self) { Text(AgentIdentity.displayName(for: $0)).tag($0) } }; Picker("Profile", selection: $profile) { ForEach(store.profiles) { Text($0.name).tag($0.name) } } }; if isCoding { Section("Launch mode") { Picker("Mode", selection: $mode) { Text("Scoped").tag("scoped"); Text("Global").tag("global") }.pickerStyle(.segmented); Text(mode == "global" ? "Use the agent's global configuration." : "Use isolated Studio provider configuration.").font(.caption).foregroundStyle(.secondary) } }; Section("Session") { TextField("Workspace path", text: $workspace).textInputAutocapitalization(.never); Picker("Category", selection: $categoryID) { Text("No category").tag(0); ForEach(categories) { Text($0.name).tag($0.id) } }; Toggle("Push completion notification", isOn: $pushEnabled) }; if isCoding && mode == "scoped" { Section("Provider API") { Picker("API mode", selection: $apiMode) { Text("Responses").tag("codex_responses"); Text("Chat Completions").tag("chat_completions"); Text("Anthropic Messages").tag("anthropic_messages") }; TextField("Base URL", text: $baseURL).textInputAutocapitalization(.never).keyboardType(.URL); SecureField("API key", text: $apiKey) } }; Section { Button("Start conversation") { store.open(makeSession()); dismiss() }.frame(maxWidth: .infinity) } }.navigationTitle("New conversation").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }.onAppear { if profile.isEmpty { profile = store.selectedProfile } } } }
    private func makeSession() -> SessionSummary { var json: JSON = ["id": UUID().uuidString, "title": String(localized: "New conversation"), "profile": profile.nilIfEmpty ?? store.selectedProfile, "agent": agent, "source": isCoding ? "coding_agent" : "cli", "agent_mode": mode, "workspace": workspace, "api_mode": apiMode, "base_url": baseURL, "api_key": apiKey, "push_enabled": pushEnabled]; if categoryID > 0 { json["category_id"] = categoryID }; return SessionSummary(json, profile: profile) }
}

/// Category management (create / rename / delete) — web "Manage categories".
struct SessionCategoriesView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Binding var categories: [SessionCategory]
    @State private var newName = ""
    @State private var editing: SessionCategory?
    @State private var editName = ""
    var body: some View {
        List {
            Section("New category") { HStack { TextField("Category name", text: $newName).contentDirection(of: newName); Button("Add") { Task { await create() } }.disabled(newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) } }
            Section("Categories") {
                if categories.isEmpty { Text("No categories yet").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted) }
                ForEach(categories) { category in Button { editing = category; editName = category.name } label: { Label(category.name, systemImage: "folder.fill") }.foregroundStyle(.primary) }
                    .onDelete { offsets in for index in offsets { Task { await remove(categories[index]) } } }
            }
        }.navigationTitle("Session categories").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .alert("Rename category", isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) { TextField("Category name", text: $editName); Button("Save") { Task { await rename() } }; Button("Cancel", role: .cancel) {} }
    }
    private func refresh() async { categories = (try? await store.api.sessionCategories()) ?? categories; store.sessionsChanged() }
    private func create() async { do { _ = try await store.api.createSessionCategory(newName); newName = ""; await refresh() } catch { store.errorMessage = error.localizedDescription } }
    private func rename() async { guard let editing else { return }; do { try await store.api.renameSessionCategory(editing.id, name: editName); self.editing = nil; await refresh() } catch { store.errorMessage = error.localizedDescription } }
    private func remove(_ category: SessionCategory) async { do { try await store.api.deleteSessionCategory(category.id); await refresh() } catch { store.errorMessage = error.localizedDescription } }
}
