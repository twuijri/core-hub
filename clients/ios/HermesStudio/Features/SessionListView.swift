import SwiftUI

/// The drawer's session list: RECENT → Pinned → categories → Uncategorized,
/// two-line rows, the long-press menu (rename / pin / category / archive /
/// export / settings / delete), category ⋯ menus (rename, delete, move its
/// sessions), batch selection and the "All profiles" toggle (web
/// `SessionListItem.vue` + `session-category-groups.ts`).
struct SessionListView: View {
    @EnvironmentObject private var store: AppStore
    @State private var sessions: [SessionSummary] = []
    @State private var categories: [SessionCategory] = []
    @State private var loading = true
    @State private var renaming: SessionSummary?
    @State private var renameText = ""
    @State private var deleting: SessionSummary?
    @State private var managing: SessionSummary?
    @State private var managingCategories = false
    @State private var editingRecentCount = false
    @State private var recentCountText = ""
    @State private var renamingCategory: SessionCategory?
    @State private var categoryName = ""
    @State private var deletingCategory: SessionCategory?
    @State private var exportURL: URL?
    @State private var selection = SessionBatchSelection()
    /// Bumped after any local preference change (pin, collapse, recent count).
    @State private var prefsVersion = 0

    private var actions: SessionActions { SessionActions(store: store) }

    private var groups: [SessionGroup] {
        _ = prefsVersion
        return SessionGrouping.groups(
            sessions: sessions,
            categories: categories,
            pinnedIDs: store.browserPrefs.pinnedIDs(profile: store.selectedProfile),
            recentCount: store.browserPrefs.recentCount,
            labels: .init(recent: String(localized: "Recent"), pinned: String(localized: "Pinned"), uncategorized: String(localized: "Uncategorized"))
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            listHeader
            List {
                if loading && sessions.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear).listRowSeparator(.hidden)
                } else if sessions.isEmpty {
                    Text("No conversations").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted).listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
                ForEach(groups) { group in
                    Section {
                        if !store.browserPrefs.isCollapsed(group.id) {
                            ForEach(group.sessions) { session in row(session) }
                        }
                    } header: { header(group) }
                }
            }
            .drawerListStyle()
            if selection.active {
                SessionBatchBar(
                    selectedCount: selection.ids.count,
                    archiveCount: selection.archiveTargets(in: sessions).count,
                    unarchiveCount: 0,
                    categories: categories,
                    onArchive: { Task { await actions.batchArchive(selection.archiveTargets(in: sessions), archived: true); selection.clear() } },
                    onUnarchive: {},
                    onMove: { category in Task { await actions.batchAssign(selection.selected(in: sessions), category: category); selection.clear() } },
                    onDelete: { Task { await actions.batchDelete(selection.selected(in: sessions)); selection.clear() } },
                    onCancel: { selection.clear() }
                )
            }
        }
        .task(id: "\(store.sessionListProfile ?? "*")|\(store.sessionListVersion)") { await load() }
        .alert("Rename conversation", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $renameText)
            Button("Save") { if let renaming { Task { await actions.rename(renaming, to: renameText) } }; renaming = nil }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .alert("Recent conversations", isPresented: $editingRecentCount) {
            TextField("Count (1–100)", text: $recentCountText).keyboardType(.numberPad)
            Button("Save") { store.browserPrefs.recentCount = Int(recentCountText) ?? store.browserPrefs.recentCount; prefsVersion &+= 1 }
            Button("Cancel", role: .cancel) {}
        } message: { Text("How many conversations to show under Recent.") }
        .alert("Rename category", isPresented: Binding(get: { renamingCategory != nil }, set: { if !$0 { renamingCategory = nil } })) {
            TextField("Category name", text: $categoryName)
            Button("Save") { if let category = renamingCategory { Task { await renameCategory(category, to: categoryName) } }; renamingCategory = nil }
            Button("Cancel", role: .cancel) { renamingCategory = nil }
        }
        .confirmationDialog("Delete category?", isPresented: Binding(get: { deletingCategory != nil }, set: { if !$0 { deletingCategory = nil } }), presenting: deletingCategory) { category in
            Button("Delete category", role: .destructive) { Task { await deleteCategory(category) } }
            Button("Cancel", role: .cancel) { deletingCategory = nil }
        } message: { category in Text("Conversations in \(category.name) become uncategorized.") }
        .confirmationDialog("Delete conversation?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { session in
            Button("Delete", role: .destructive) { Task { await actions.delete(session) } }
            Button("Cancel", role: .cancel) { deleting = nil }
        } message: { session in Text(session.title) }
        .sheet(item: $managing) { item in SessionManagementView(session: item, categories: categories).environmentObject(store) }
        .sheet(isPresented: $managingCategories) { NavigationStack { SessionCategoriesView(categories: $categories) }.environmentObject(store) }
        .sheet(item: $exportURL) { url in ExportShareSheet(url: url) }
    }

    // MARK: Header row (profile scope + selection mode)

    private var listHeader: some View {
        HStack(spacing: 6) {
            Button { store.setAllProfilesSessions(!store.allProfilesSessions) } label: {
                HStack(spacing: 4) {
                    Image(systemName: store.allProfilesSessions ? "person.2.fill" : "person.fill").font(.system(size: 11))
                    Text(store.allProfilesSessions ? "All profiles" : "This profile").font(CoreHubTokens.Typography.categoryTagFont)
                }
                .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                .padding(.horizontal, 8)
                .frame(height: 22)
                .background(CoreHubTokens.Palette.hover, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(store.allProfilesSessions ? "Showing all profiles" : "Showing this profile")
            Spacer(minLength: 0)
            Button { withAnimation(CoreHubTokens.Motion.quick) { selection.active.toggle(); if !selection.active { selection.ids = [] } } } label: {
                Text(selection.active ? "Done" : "Select").font(CoreHubTokens.Typography.categoryTagFont)
                    .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                    .padding(.horizontal, 8)
                    .frame(height: 22)
                    .background(selection.active ? CoreHubTokens.Palette.selected : CoreHubTokens.Palette.hover, in: Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }

    // MARK: Group header

    private func header(_ group: SessionGroup) -> some View {
        HStack(spacing: 4) {
            Button {
                store.browserPrefs.setCollapsed(group.id, !store.browserPrefs.isCollapsed(group.id))
                withAnimation(CoreHubTokens.Motion.quick) { prefsVersion &+= 1 }
            } label: {
                GroupHeaderLabel(title: group.label, count: group.count, expanded: !store.browserPrefs.isCollapsed(group.id))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if group.kind == .recent {
                Button { recentCountText = "\(store.browserPrefs.recentCount)"; editingRecentCount = true } label: {
                    CoreHubIconView(icon: .settings, size: 12).foregroundStyle(CoreHubTokens.Palette.textMuted).frame(width: 24, height: 24).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Recent count")
            } else if case let .category(id) = group.kind, let category = categories.first(where: { $0.id == id }) {
                categoryMenu(category, sessions: group.sessions)
            } else if group.kind == .uncategorized {
                Menu {
                    Button("Manage categories") { managingCategories = true }
                } label: { moreIcon }
                .accessibilityLabel("Category options")
            }
        }
        .padding(.vertical, 2)
    }

    private var moreIcon: some View {
        CoreHubIconView(icon: .more, size: 14).foregroundStyle(CoreHubTokens.Palette.textMuted).frame(width: 24, height: 24).contentShape(Rectangle())
    }

    /// ⋯ menu of a category group: rename, move its sessions, delete.
    private func categoryMenu(_ category: SessionCategory, sessions members: [SessionSummary]) -> some View {
        Menu {
            Button { categoryName = category.name; renamingCategory = category } label: { Label("Rename category", systemImage: "pencil") }
            Menu {
                Button("No category") { Task { await actions.batchAssign(members, category: nil) } }
                ForEach(categories.filter { $0.id != category.id }) { target in
                    Button(target.name) { Task { await actions.batchAssign(members, category: target.id) } }
                }
            } label: { Label("Move conversations to…", systemImage: "folder") }
            Button("Manage categories") { managingCategories = true }
            Divider()
            Button(role: .destructive) { deletingCategory = category } label: { Label("Delete category", systemImage: "trash") }
        } label: { moreIcon }
        .accessibilityLabel("Category options")
    }

    // MARK: Row

    private func row(_ session: SessionSummary) -> some View {
        let pinned = store.browserPrefs.isPinned(session.id, profile: store.selectedProfile)
        return HStack(spacing: 2) {
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
        .listRowInsets(EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 6))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .contextMenu {
            SessionContextMenu(
                session: session, pinned: pinned, categories: categories,
                onRename: { renameText = session.title; renaming = session },
                onPin: { store.browserPrefs.togglePin(session.id, profile: store.selectedProfile); prefsVersion &+= 1 },
                onAssign: { category in Task { await actions.assign(session, category: category) } },
                onArchive: { Task { await actions.archive(session) } },
                onExport: { mode, ext in Task { exportURL = await actions.export(session, mode: mode, ext: ext) } },
                onSettings: { managing = session },
                onDelete: { deleting = session }
            )
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { deleting = session } label: { Label("Delete", systemImage: "trash") }
            if session.source != "global_agent" {
                Button { Task { await actions.archive(session) } } label: { Label("Archive", systemImage: "archivebox") }.tint(CoreHubTokens.Palette.warning)
            }
        }
    }

    // MARK: Data

    private func load() async {
        loading = true
        do {
            async let categoryRequest = store.api.sessionCategories()
            sessions = try await store.api.sessions(profile: store.sessionListProfile, limit: 100).filter { !$0.archived }
            categories = try await categoryRequest
            store.browserPrefs.prunePins(existing: Set(sessions.map(\.id)), profile: store.selectedProfile)
        } catch { store.errorMessage = error.localizedDescription }
        loading = false
    }

    private func renameCategory(_ category: SessionCategory, to name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await store.attempt { try await store.api.renameSessionCategory(category.id, name: trimmed) }
        store.sessionsChanged()
    }

    private func deleteCategory(_ category: SessionCategory) async {
        await store.attempt { try await store.api.deleteSessionCategory(category.id) }
        deletingCategory = nil
        store.sessionsChanged()
    }
}

/// Two-line session row (padding 8×10, radius 6): pin · unread dot · title
/// (per-string direction) … time / agent avatar · profile chip · category tag.
struct SessionRowView: View {
    let session: SessionSummary
    var categoryLabel: String?
    var pinned = false
    var unread = false
    var selected = false
    var streaming = false
    var profileAvatar: AvatarSpec?
    var time: String
    let open: () -> Void
    let requestDelete: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Button(action: open) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        if pinned {
                            CoreHubIconView(icon: .pin, size: CoreHubTokens.Layout.pinIcon).foregroundStyle(CoreHubTokens.Palette.accent)
                        }
                        if unread {
                            Circle().fill(CoreHubTokens.Palette.accent)
                                .frame(width: CoreHubTokens.Layout.unreadDot, height: CoreHubTokens.Layout.unreadDot)
                                .background(Circle().fill(CoreHubTokens.Palette.accent.opacity(CoreHubTokens.Alpha.unreadHalo)).padding(-3))
                        }
                        if session.archived {
                            Image(systemName: "archivebox").font(.system(size: 10)).foregroundStyle(CoreHubTokens.Palette.textMuted)
                        }
                        DirectionalText(text: session.title, font: CoreHubTokens.Typography.font(CoreHubTokens.Typography.sessionTitle, weight: selected ? .medium : .regular))
                        Text(time)
                            .font(CoreHubTokens.Typography.metaFont)
                            .foregroundStyle(CoreHubTokens.Palette.textMuted)
                            .lineLimit(1)
                            .fixedSize()
                    }
                    HStack(spacing: 6) {
                        AgentAvatarView(asset: AgentAvatarAsset.resolve(session: session), streaming: streaming)
                        HStack(spacing: 4) {
                            ProfileAvatar(name: session.profile, avatar: profileAvatar, size: CoreHubTokens.Layout.profileChipAvatar)
                            Text(session.profile).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted).lineLimit(1)
                        }
                        if let categoryLabel, !categoryLabel.isEmpty {
                            Text(categoryLabel)
                                .font(CoreHubTokens.Typography.categoryTagFont)
                                .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                                .lineLimit(1)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(CoreHubTokens.Palette.categoryTag, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.tag))
                                .frame(maxWidth: CoreHubTokens.Layout.drawerMaxWidth * CoreHubTokens.Layout.categoryTagMaxWidthFraction, alignment: .leading)
                        }
                        Spacer(minLength: 0)
                    }
                }
                .padding(.vertical, CoreHubTokens.Layout.sessionRowVertical)
                .padding(.horizontal, CoreHubTokens.Layout.sessionRowHorizontal)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(selected ? CoreHubTokens.Palette.selected : Color.clear, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.button, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(RailButtonStyle())
            Button(action: requestDelete) {
                CoreHubIconView(icon: .close, size: 12)
                    .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                    .opacity(CoreHubTokens.Alpha.deleteAffordance)
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Delete")
        }
        .accessibilityElement(children: .contain)
    }
}
