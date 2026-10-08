// The chats list (segment `chat`): pinned, recent, a search field, the active / archived / all
// filter, and its own profile filter — «All profiles» on every entry into the app, or one
// profile, hidden for someone with one profile (profileScope.listFilter, ADR 0016). It never
// moves the profile selector, and the selector never moves it.
import CoreHubClient
import Observation
import SwiftUI

enum SessionFilter: String, CaseIterable, Identifiable {
    case active
    case archived
    case all

    var id: String { rawValue }
    var labelKey: String { "sessions.filter_\(rawValue)" }

    var archivedParameter: SessionsAPI.Archived_sessionsList {
        switch self {
        case .active: return ._false
        case .archived: return ._true
        case .all: return .all
        }
    }
}

@MainActor
@Observable
final class SessionListModel {
    /// `nil` = every profile the person may enter.
    var profileFilter: String?
    var filter: SessionFilter = .active
    var query = ""
    private(set) var sessions: [Session] = []
    private(set) var loading = false
    private(set) var error: HubFailure?
    private(set) var nextCursor: String?
    /// Batch mode: the conversations selected (empty = not selecting).
    private(set) var selected: Set<String> = []
    private(set) var batchBusy = false
    var batchError: String?
    /// The last one-chat action (rename, pin, archive, delete) that failed.
    var actionError: String?
    /// The categories of the listed profiles (contract decision §60).
    private(set) var categories: [SessionCategory] = []
    /// The conversations Hermes keeps on each channel, hidden ones marked (§61, §88).
    private(set) var conversations: [ChannelConversation] = []
    /// Hermes could not be read for some profile: the list says so and keeps what it had.
    private(set) var channelsUnavailable = false
    /// Hidden channel conversations shown too ("Show hidden chats").
    var showHidden = false
    /// The hub announces each channel turn (`channel_conversation.updated`, §153): the polling slows down.
    private(set) var channelsLive = false
    /// Categories folded shut, by id (this phone's own choice).
    var folded: Set<String> = []
    /// The order the person dragged the chats into, for this view (SessionOrder.swift).
    private(set) var manual: [String] = []
    @ObservationIgnored private var orderScope: String?

    private var currentScope: String { profileFilter ?? "all" }

    /// Drops `moved` just before `target` in a group as drawn; false when nothing moved.
    @discardableResult
    func reorder(_ moved: String, before target: String, among shown: [String]) -> Bool {
        guard let next = SessionOrder.drop(moved, before: target, shown: shown) else { return false }
        setOrder(next)
        return true
    }

    func setOrder(_ group: [String]) {
        manual = SessionOrder.merge(group, into: manual)
        SessionOrder.write(manual, scope: currentScope)
    }

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var listener: UUID?
    @ObservationIgnored private var reloadTask: Task<Void, Never>?
    @ObservationIgnored private var poller: Task<Void, Never>?
    @ObservationIgnored private var channelReload: Task<Void, Never>?
    @ObservationIgnored private var generation = 0

    init(app: AppModel) {
        self.app = app
    }

    var pinned: [Session] { sessions.filter(\.pinned) }
    var recent: [Session] { sessions.filter { !$0.pinned } }

    /// Whether rows carry their profile's badge: the list shows more than one profile.
    var showsProfileBadges: Bool {
        profileFilter == nil && (app?.enterableProfiles.count ?? 0) > 1
    }

    /// The groups the list draws: categories, channels, then the rest (SessionGroups.swift).
    var groups: [SessionGroup] {
        let listed = filter == .archived ? [] : SessionGroups.shown(conversations, showHidden: showHidden, query: query)
        return SessionGroups.group(sessions, categories: categories, conversations: listed, keepEmpty: query.trimmingCharacters(in: .whitespaces).isEmpty, manual: manual)
    }

    var hiddenCount: Int { conversations.filter { $0.hidden == true }.count }

    func start() {
        startPolling()
        guard listener == nil, let namespace = app?.sessions else {
            reload()
            return
        }
        listener = namespace.onEvent { [weak self] name, argument in
            if name == ChannelSendRules.event {
                // A Telegram or WhatsApp conversation changed (§153): the channel groups read again.
                guard let envelope = Envelope.parse(argument), let update = ChannelSendRules.parse(envelope),
                      ChannelSendRules.settled(update) else { return }
                self?.scheduleConversations()
                return
            }
            guard name.hasPrefix("session.") else { return }
            self?.scheduleReload()
        }
        reload()
    }

    func stop() {
        if let listener { app?.sessions?.remove(listener) }
        listener = nil
        poller?.cancel()
        poller = nil
        channelReload?.cancel()
        channelReload = nil
    }

    /// The channel conversations again, once per burst of announced turns.
    private func scheduleConversations() {
        channelReload?.cancel()
        channelReload = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            await self?.loadConversations()
        }
    }

    /// The list asks again now and then while it is on screen: the web's 45 seconds where Hermes
    /// announces nothing, every 5 minutes as a fallback where the hub announces each turn (§153).
    private func startPolling() {
        guard poller == nil else { return }
        poller = Task { [weak self] in
            while !Task.isCancelled {
                let wait = ChannelSendRules.listPoll(live: self?.channelsLive)
                try? await Task.sleep(nanoseconds: wait)
                guard !Task.isCancelled else { return }
                await self?.loadConversations()
            }
        }
    }

    func loadCategories() async {
        guard let app else { return }
        let header = profileFilter ?? app.currentProfile
        let all = profileFilter == nil
        if let list = try? await app.api.call({ try await SessionsAPI.sessionsListCategories(xHubProfile: header, profiles: all ? .all : nil, apiConfiguration: $0) }) {
            categories = list.items
        }
    }

    func loadConversations() async {
        guard let app else { return }
        let header = profileFilter ?? app.currentProfile
        let all = profileFilter == nil
        do {
            let list = try await app.api.call {
                try await SessionsAPI.sessionsListChannelConversations(xHubProfile: header, profiles: all ? .all : nil, hidden: .include, apiConfiguration: $0)
            }
            conversations = list.items
            channelsUnavailable = list.unavailable.contains { $0.reason == .hermesUnreachable }
            channelsLive = list.liveUpdates == true
        } catch {
            // No Hermes, or not reachable: the chats list stands on its own.
            channelsUnavailable = !conversations.isEmpty
        }
    }

    /// Hide one from the person's own list, or show it again (§88), in its own profile.
    func setHidden(_ conversation: ChannelConversation, _ hidden: Bool) async {
        guard let app else { return }
        let profile = conversation.profile, id = conversation.id
        do {
            if hidden {
                try await app.api.call { try await SessionsAPI.sessionsHideChannelConversation(xHubProfile: profile, conversationId: id, apiConfiguration: $0) }
            } else {
                try await app.api.call { try await SessionsAPI.sessionsUnhideChannelConversation(xHubProfile: profile, conversationId: id, apiConfiguration: $0) }
            }
            actionError = nil
        } catch {
            actionError = HubFailure(error).describe(app.l10n)
        }
        await loadConversations()
    }

    /// An admin deletes it from Hermes for everyone (§88).
    func deleteConversation(_ conversation: ChannelConversation) async throws {
        guard let app else { return }
        let profile = conversation.profile, id = conversation.id
        try await app.api.call { try await SessionsAPI.sessionsDeleteChannelConversation(xHubProfile: profile, conversationId: id, apiConfiguration: $0) }
        conversations.removeAll { $0.id == id }
    }

    // MARK: - Categories

    func createCategory(_ name: String, profile: String) async -> SessionCategory? {
        guard let app else { return nil }
        do {
            let made = try await app.api.call { try await SessionsAPI.sessionsCreateCategory(xHubProfile: profile, sessionCategoryInput: SessionCategoryInput(name: name), apiConfiguration: $0) }
            actionError = nil
            await loadCategories()
            return made
        } catch {
            actionError = HubFailure(error).describe(app.l10n)
            return nil
        }
    }

    func updateCategory(_ category: SessionCategory, _ input: SessionCategoryInput) async {
        guard let app else { return }
        let profile = category.profile, id = category.id
        do {
            _ = try await app.api.call { try await SessionsAPI.sessionsUpdateCategory(xHubProfile: profile, categoryId: id, sessionCategoryInput: input, apiConfiguration: $0) }
            actionError = nil
        } catch {
            actionError = HubFailure(error).describe(app.l10n)
        }
        await loadCategories()
    }

    func deleteCategory(_ category: SessionCategory) async throws {
        guard let app else { return }
        let profile = category.profile, id = category.id
        try await app.api.call { try await SessionsAPI.sessionsDeleteCategory(xHubProfile: profile, categoryId: id, apiConfiguration: $0) }
        await loadCategories()
        reload()
    }

    /// Files a chat under a category of its profile, or under none.
    func move(_ session: Session, to category: String?) async {
        let patch = category.map { SessionPatch(categoryId: $0) } ?? SessionPatch(sendNull: [.categoryId])
        await change(session, patch)
    }

    var selecting: Bool { !selected.isEmpty }

    func toggle(_ id: String) { selected = SessionBatch.toggle(selected, id) }

    func clearSelection() {
        selected = []
        batchError = nil
    }

    /// Archive (or bring back) every selected conversation, one call per profile.
    func archiveSelected(_ archived: Bool) async {
        await batch { profile, ids, config in
            try await SessionsAPI.sessionsBulkUpdate(
                xHubProfile: profile,
                sessionBulkUpdate: SessionBulkUpdate(sessionIds: ids, patch: SessionBulkUpdatePatch(archived: archived)),
                apiConfiguration: config
            )
        }
    }

    func deleteSelected() async {
        await batch { profile, ids, config in
            try await SessionsAPI.sessionsBulkDelete(xHubProfile: profile, ids: ids.joined(separator: ","), apiConfiguration: config)
        }
    }

    private func batch(_ call: @escaping (String, [String], CoreHubClientAPIConfiguration) async throws -> BulkResult) async {
        guard let app else { return }
        let groups = SessionBatch.byProfile(sessions, selected)
        guard !groups.isEmpty else { return }
        batchBusy = true
        batchError = nil
        var results: [BulkResult] = []
        var failure: String?
        for (profile, ids) in groups {
            do {
                results.append(try await app.api.call { try await call(profile, ids, $0) })
            } catch {
                failure = HubFailure(error).describe(app.l10n)
            }
        }
        let refused = SessionBatch.failures(results)
        batchBusy = false
        batchError = failure ?? refused.first
        if failure == nil && refused.isEmpty { selected = [] }
        reload()
    }

    /// One chat's rename, pin or archive, in its own profile; the list follows from the hub.
    func change(_ session: Session, _ patch: SessionPatch) async {
        guard let app else { return }
        do {
            _ = try await ChatActions.update(app, id: session.id, profile: session.profile, patch)
            actionError = nil
        } catch {
            actionError = HubFailure(error).describe(app.l10n)
        }
        reload()
    }

    func delete(_ session: Session) async throws {
        guard let app else { return }
        try await ChatActions.delete(app, id: session.id, profile: session.profile)
        sessions.removeAll { $0.id == session.id }
        selected.remove(session.id)
    }

    /// Hub-side changes arrive in bursts (a title, then the status…); one refetch covers them.
    func scheduleReload() {
        reloadTask?.cancel()
        reloadTask = Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            reload()
        }
    }

    func reload() {
        guard let app else { return }
        generation += 1
        let current = generation
        let profileFilter = profileFilter
        let header = profileFilter ?? app.currentProfile
        let archived = filter.archivedParameter
        let profiles: SessionsAPI.Profiles_sessionsList? = profileFilter == nil ? .all : nil
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if orderScope != currentScope {
            orderScope = currentScope
            manual = SessionOrder.read(currentScope)
        }
        loading = true
        Task { await loadCategories() }
        Task { await loadConversations() }
        Task {
            do {
                let page = try await app.api.call {
                    try await SessionsAPI.sessionsList(
                        xHubProfile: header,
                        profiles: profiles,
                        archived: archived,
                        q: q.isEmpty ? nil : q,
                        limit: 100,
                        apiConfiguration: $0
                    )
                }
                guard current == generation else { return }
                // The global agent's conversation is not in the list (DECISIONS §46).
                sessions = page.items.filter { $0.source != .globalAgent }
                nextCursor = page.nextCursor
                error = nil
            } catch {
                guard current == generation else { return }
                self.error = HubFailure(error)
            }
            if current == generation { loading = false }
        }
    }
}

struct SessionListView: View {
    @Bindable var model: SessionListModel
    let selected: String?
    let open: (Session) -> Void
    /// A channel conversation Hermes keeps opens as its read-only transcript.
    var openChannel: (ChannelConversation) -> Void = { _ in }
    var selectedChannel: String? = nil
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var confirmingDelete = false
    @State private var renaming: RenameTarget?
    @State private var deleting: Session?
    /// Categories: a new one's name, a rename, a delete; a chat being filed.
    @State private var naming: CategoryNaming?
    @State private var deletingCategory: SessionCategory?
    @State private var moving: Keyed<Session>?
    @State private var deletingConversation: ChannelConversation?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            controls
            if model.selecting { batchBar }
            if let failure = model.actionError {
                NoticeView(text: failure, tone: .danger)
                    .onTapGesture { model.actionError = nil }
            }
            if let error = model.error {
                NoticeView(text: error.describe(l10n), tone: .danger)
                Button(l10n("common.retry")) { model.reload() }
                    .font(.system(size: FontSize.sizeSm))
            } else if model.sessions.isEmpty && !model.loading {
                Text(model.query.isEmpty && model.filter == .active ? l10n("sessions.empty") : l10n("sessions.empty_filtered"))
                    .font(.system(size: FontSize.sizeSm))
                    .foregroundStyle(Tone.textMuted)
                    .padding(.vertical, Space.s4)
            }
            if model.channelsUnavailable {
                Text(l10n("session_groups.channels.unreachable"))
                    .font(.system(size: FontSize.sizeXs))
                    .foregroundStyle(Tone.textMuted)
            }
            ForEach(model.groups) { group in
                groupView(group)
            }
            footerButtons
        }
        .onAppear { model.start() }
        .onDisappear { model.stop() }
        .alert(naming?.title ?? "", isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
            TextField(l10n("session_groups.categories.new_label"), text: Binding(get: { naming?.text ?? "" }, set: { naming?.text = $0 }))
            Button(l10n("common.cancel"), role: .cancel) { naming = nil }
            Button(l10n("common.save")) {
                guard let target = naming else { return }
                naming = nil
                let name = target.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                Task {
                    if let category = target.category {
                        await model.updateCategory(category, SessionCategoryInput(name: name))
                    } else if let made = await model.createCategory(name, profile: target.profile), let session = target.fileAfter {
                        await model.move(session, to: made.id)
                    }
                }
            }
        } message: {
            if let naming, naming.category == nil {
                Text(l10n("session_groups.categories.new_in_profile", ["profile": app.profileName(naming.profile)]))
            }
        }
        .confirmDelete($deletingCategory, name: { $0.name }) { category in
            try await model.deleteCategory(category)
        }
        .confirmDelete($deletingConversation, name: { SessionGroups.title($0, l10n) }) { conversation in
            try await model.deleteConversation(conversation)
        }
        .sheet(item: $moving) { keyed in
            let session = keyed.value
            NavigationStack {
                MoveToCategorySheet(session: session, categories: model.categories.filter { $0.profile == session.profile }) { choice in
                    Task { await model.move(session, to: choice) }
                } newCategory: {
                    naming = CategoryNaming(title: l10n("session_groups.categories.new"), profile: session.profile, fileAfter: session)
                }
            }
            .presentationDetents([.medium, .large])
        }
        .renameChat($renaming) { target, typed in
            guard let title = ChatControls.renameTitle(typed),
                  let session = model.sessions.first(where: { $0.id == target.id }) else { return }
            await model.change(session, SessionPatch(title: title))
        }
        .confirmDelete($deleting, name: { $0.title ?? l10n("sessions.untitled") }) { session in
            try await model.delete(session)
        }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            HStack(spacing: Space.s2) {
                LucideIcon(.search, size: 16).foregroundStyle(Tone.textFaint)
                TextField(l10n("sessions.search_placeholder"), text: $model.query)
                    .textInputAutocapitalization(.never)
                    .submitLabel(.search)
                    .onSubmit { model.reload() }
                    .onChange(of: model.query) { _, _ in model.scheduleReload() }
            }
            .font(.system(size: FontSize.sizeSm))
            .padding(.horizontal, Space.s3)
            .frame(height: Control.heightMd)
            .background(Tone.surface, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))

            HStack(spacing: Space.s2) {
                if app.enterableProfiles.count > 1 {
                    profileFilterMenu
                }
                Picker("", selection: $model.filter) {
                    ForEach(SessionFilter.allCases) { filter in
                        Text(l10n(filter.labelKey)).tag(filter)
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: model.filter) { _, _ in model.reload() }
            }
        }
    }

    /// Batch mode: how many are selected, and archive, bring back or delete them all.
    private var batchBar: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            HStack {
                Button { model.clearSelection() } label: { LucideIcon(.x, size: 18).tapTarget() }
                    .accessibilityLabel(l10n("sessions.batch_done"))
                Text(l10n("sessions.batch_selected", ["count": String(model.selected.count)]))
                    .font(.system(size: FontSize.sizeSm, weight: .semibold))
                Spacer()
            }
            HStack(spacing: Space.s3) {
                Button(l10n("sessions.batch_archive")) { Task { await model.archiveSelected(true) } }
                    .accessibilityIdentifier("sessions.batch.archive")
                Button(l10n("sessions.batch_unarchive")) { Task { await model.archiveSelected(false) } }
                    .accessibilityIdentifier("sessions.batch.unarchive")
                Button(l10n("sessions.batch_delete"), role: .destructive) { confirmingDelete = true }
                    .accessibilityIdentifier("sessions.batch.delete")
            }
            .font(.system(size: FontSize.sizeSm))
            .disabled(model.batchBusy)
            if let error = model.batchError {
                Text(error).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.dangerSoftText)
            }
        }
        .padding(Space.s2)
        .background(Tone.surface, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
        .accessibilityIdentifier("sessions.batch")
        .confirmationDialog(
            l10n("sessions.batch_delete_title", ["count": String(model.selected.count)]),
            isPresented: $confirmingDelete,
            titleVisibility: .visible
        ) {
            Button(l10n("sessions.batch_delete"), role: .destructive) { Task { await model.deleteSelected() } }
            Button(l10n("common.cancel"), role: .cancel) {}
        } message: {
            Text(l10n("sessions.batch_delete_body"))
        }
    }

    private var profileFilterMenu: some View {
        Menu {
            Button(l10n("sessions.all_profiles")) {
                model.profileFilter = nil
                model.reload()
            }
            ForEach(app.enterableProfiles, id: \.self) { slug in
                Button(app.profileName(slug)) {
                    model.profileFilter = slug
                    model.reload()
                }
            }
        } label: {
            HStack(spacing: Space.s1) {
                Text(model.profileFilter.map(app.profileName) ?? l10n("sessions.all_profiles"))
                    .lineLimit(1)
                LucideIcon(.chevronDown, size: 12)
            }
            .font(.system(size: FontSize.sizeSm))
            .padding(.horizontal, Space.s2)
            .frame(height: Control.heightSm)
            .background(Tone.surface2, in: Capsule())
        }
        .accessibilityIdentifier("sessions.profile_filter")
    }

    @ViewBuilder
    private func groupView(_ group: SessionGroup) -> some View {
        switch group.kind {
        case .category(let category):
            VStack(alignment: .leading, spacing: 2) {
                categoryHeader(category, count: group.sessions.count)
                    // A chat dropped on a category's heading is filed there (as on the web).
                    .dropDestination(for: String.self) { ids, _ in
                        guard let id = ids.first, let session = model.sessions.first(where: { $0.id == id }),
                              session.profile == category.profile, session.categoryId != category.id else { return false }
                        Task { await model.move(session, to: category.id) }
                        return true
                    }
                if !model.folded.contains(category.id) {
                    if group.sessions.isEmpty {
                        Text(l10n("session_groups.categories.empty_group"))
                            .font(.system(size: FontSize.sizeXs))
                            .foregroundStyle(Tone.textFaint)
                            .padding(.horizontal, Space.s2)
                    }
                    ForEach(group.sessions, id: \.id) { session in row(session, in: group.sessions) }
                }
            }
            .accessibilityIdentifier("sessions.category.\(category.id)")
        case .channel(let platform):
            VStack(alignment: .leading, spacing: 2) {
                groupTitle(SessionGroups.channelHeading(platform, l10n))
                ForEach(group.sessions, id: \.id) { session in row(session, in: group.sessions) }
                ForEach(group.conversations, id: \.id) { conversation in conversationRow(conversation) }
            }
            .accessibilityIdentifier("sessions.channel.\(platform)")
        case .rest:
            let pinned = group.sessions.filter(\.pinned)
            let recent = group.sessions.filter { !$0.pinned }
            if !pinned.isEmpty {
                section(l10n("sessions.pinned"), pinned)
            }
            if !recent.isEmpty {
                section(l10n("sessions.recent") + " · \(recent.count)", recent)
            }
        }
    }

    private func groupTitle(_ title: String) -> some View {
        Text(title)
            .font(.system(size: FontSize.sizeXs, weight: .semibold))
            .foregroundStyle(Tone.textFaint)
            .padding(.top, Space.s2)
    }

    private func categoryHeader(_ category: SessionCategory, count: Int) -> some View {
        HStack(spacing: Space.s2) {
            Button {
                if model.folded.contains(category.id) { model.folded.remove(category.id) } else { model.folded.insert(category.id) }
            } label: {
                HStack(spacing: Space.s1) {
                    LucideIcon(model.folded.contains(category.id) ? .chevronRight : .chevronDown, size: 12)
                        .flipsForRightToLeftLayoutDirection(true)
                    if let colour = SessionGroups.colour(category.color) {
                        Circle().fill(colour).frame(width: 8, height: 8)
                    }
                    Text(category.name).lineLimit(1).contentDirection(of: category.name, fill: false)
                    Text(String(count)).foregroundStyle(Tone.textFaint)
                    if model.showsProfileBadges { ProfileBadge(name: app.profileName(category.profile)) }
                }
                .font(.system(size: FontSize.sizeXs, weight: .semibold))
                .foregroundStyle(Tone.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(category.name + " · " + l10n("session_groups.categories.count", ["count": String(count)]))
            Spacer()
            Menu {
                Button {
                    naming = CategoryNaming(title: l10n("session_groups.categories.rename"), profile: category.profile, category: category, text: category.name)
                } label: { Label { Text(l10n("session_groups.categories.rename")) } icon: { Image(lucide: .pencil) } }
                Menu {
                    Button(l10n("session_groups.categories.colour_none")) { Task { await model.updateCategory(category, SessionCategoryInput(sendNull: [.color])) } }
                    ForEach(SessionGroups.colours, id: \.id) { swatch in
                        Button(l10n("session_groups.categories.colours.\(swatch.id)")) {
                            Task { await model.updateCategory(category, SessionCategoryInput(color: swatch.hex)) }
                        }
                    }
                } label: { Label { Text(l10n("session_groups.categories.colour")) } icon: { Image(lucide: .palette) } }
                if let up = SessionGroups.moved(category, by: -1, in: model.categories) {
                    Button { Task { await model.updateCategory(category, SessionCategoryInput(position: up)) } } label: {
                        Label { Text(l10n("session_groups.categories.move_up")) } icon: { Image(lucide: .chevronUp) }
                    }
                }
                if let down = SessionGroups.moved(category, by: 1, in: model.categories) {
                    Button { Task { await model.updateCategory(category, SessionCategoryInput(position: down)) } } label: {
                        Label { Text(l10n("session_groups.categories.move_down")) } icon: { Image(lucide: .chevronDown) }
                    }
                }
                Button(role: .destructive) { deletingCategory = category } label: {
                    Label { Text(l10n("session_groups.categories.delete")) } icon: { Image(lucide: .trash) }
                }
            } label: {
                LucideIcon(.ellipsis, size: 14).foregroundStyle(Tone.textFaint).tapTarget(32)
            }
            .accessibilityLabel(l10n("session_groups.categories.more", ["name": category.name]))
            .accessibilityIdentifier("sessions.category.\(category.id).more")
        }
        .padding(.top, Space.s2)
    }

    private func conversationRow(_ conversation: ChannelConversation) -> some View {
        let title = SessionGroups.title(conversation, l10n)
        let preview = SessionGroups.preview(conversation, l10n)
        return Button {
            openChannel(conversation)
        } label: {
            HStack(spacing: Space.s2) {
                LucideIcon(.radio, size: 16).foregroundStyle(Tone.textMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: FontSize.sizeSm, weight: .medium))
                        .foregroundStyle(Tone.text)
                        .lineLimit(1)
                        .contentDirection(of: title)
                    if !preview.isEmpty {
                        Text(preview)
                            .font(.system(size: FontSize.sizeXs))
                            .foregroundStyle(Tone.textMuted)
                            .lineLimit(1)
                            .contentDirection(of: preview)
                    }
                }
                if conversation.hidden == true {
                    LucideIcon(.eyeOff, size: 12).foregroundStyle(Tone.textFaint)
                }
                if model.showsProfileBadges {
                    ProfileBadge(name: app.profileName(conversation.profile))
                }
            }
            .padding(.horizontal, Space.s2)
            .padding(.vertical, Space.s2)
            .background(selectedChannel == conversation.id ? Tone.surface2 : Color.clear, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if conversation.hidden == true {
                Button { Task { await model.setHidden(conversation, false) } } label: {
                    Label { Text(l10n("session_groups.channels.unhide")) } icon: { Image(lucide: .eye) }
                }
            } else {
                Button { Task { await model.setHidden(conversation, true) } } label: {
                    Label { Text(l10n("session_groups.channels.hide")) } icon: { Image(lucide: .eyeOff) }
                }
            }
            if app.isAdmin {
                Button(role: .destructive) { deletingConversation = conversation } label: {
                    Label { Text(l10n("session_groups.channels.delete")) } icon: { Image(lucide: .trash) }
                }
            }
        }
        .accessibilityIdentifier("channel_conversation.\(conversation.id)")
    }

    @ViewBuilder
    private var footerButtons: some View {
        if model.filter != .archived && model.hiddenCount > 0 {
            Button(model.showHidden ? l10n("session_groups.channels.hide_hidden") : l10n("session_groups.channels.show_hidden", ["count": String(model.hiddenCount)])) {
                model.showHidden.toggle()
            }
            .font(.system(size: FontSize.sizeXs))
            .accessibilityIdentifier("sessions.show_hidden")
        }
        if model.filter == .active && model.query.isEmpty {
            Button {
                naming = CategoryNaming(title: l10n("session_groups.categories.new"), profile: model.profileFilter ?? app.currentProfile)
            } label: {
                LucideLabel(l10n("session_groups.categories.new"), icon: .folderPlus, size: 14)
            }
            .font(.system(size: FontSize.sizeXs))
            .padding(.top, Space.s2)
            .accessibilityIdentifier("sessions.category.new")
        }
    }

    private func section(_ title: String, _ sessions: [Session]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: FontSize.sizeXs, weight: .semibold))
                .foregroundStyle(Tone.textFaint)
                .padding(.top, Space.s2)
            ForEach(sessions, id: \.id) { session in
                row(session, in: sessions)
            }
        }
    }

    /// A chat's row. `list` is the rows it is drawn among: dropping another chat on it puts that one
    /// just before it there (the order is this phone's, SessionOrder.swift).
    @ViewBuilder
    private func row(_ session: Session, in list: [Session]) -> some View {
        if model.selecting {
            rowBody(session, in: list)
        } else {
            rowBody(session, in: list)
                .draggable(session.id) {
                    Text(session.title ?? l10n("sessions.untitled"))
                        .font(.system(size: FontSize.sizeSm, weight: .medium))
                        .padding(Space.s2)
                        .background(Tone.surface, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
                }
                .dropDestination(for: String.self) { ids, _ in
                    guard let moved = ids.first else { return false }
                    return model.reorder(moved, before: session.id, among: list.map(\.id))
                }
        }
    }

    private func rowBody(_ session: Session, in list: [Session]) -> some View {
        let title = session.title ?? l10n("sessions.untitled")
        let chosen = model.selected.contains(session.id)
        return Button {
            if model.selecting { model.toggle(session.id) } else { open(session) }
        } label: {
            HStack(spacing: Space.s2) {
                if model.selecting {
                    SelectionMark(chosen: chosen)
                } else if let agent = app.agentDirectory.agents(session.profile).first(where: { $0.id == session.agentId }) {
                    // The chat's agent, by its face (its picture, its mark, or its initial).
                    AgentAvatar(identity: .of(agent), profile: session.profile, size: 22)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: FontSize.sizeSm, weight: .medium))
                        .foregroundStyle(Tone.text)
                        .lineLimit(1)
                        .contentDirection(of: title)
                    if let snippet = session.match?.snippet ?? session.preview {
                        Text(snippet)
                            .font(.system(size: FontSize.sizeXs))
                            .foregroundStyle(Tone.textMuted)
                            .lineLimit(1)
                            .contentDirection(of: snippet)
                    }
                }
                if session.status != .idle {
                    Circle().fill(Tone.statusRunning).frame(width: 6, height: 6)
                }
                if model.showsProfileBadges {
                    ProfileBadge(name: app.profileName(session.profile))
                }
            }
            .padding(.horizontal, Space.s2)
            .padding(.vertical, Space.s2)
            .background(
                chosen || (!model.selecting && selected == session.id) ? Tone.surface2 : Color.clear,
                in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // A long press offers the chat's own actions, and Select, which starts batch mode with it.
        .contextMenu {
            Button { model.toggle(session.id) } label: {
                Label { Text(l10n("sessions.batch_select")) } icon: { Image(lucide: .circleCheck) }
            }
            if session.source != .globalAgent {
                Button {
                    renaming = RenameTarget(id: session.id, profile: session.profile, title: session.title ?? "")
                } label: {
                    Label { Text(l10n("chat_controls.rename")) } icon: { Image(lucide: .pencil) }
                }
                Button {
                    Task { await model.change(session, SessionPatch(pinned: !session.pinned)) }
                } label: {
                    Label { Text(l10n(session.pinned ? "chat_controls.unpin" : "chat_controls.pin")) } icon: {
                        Image(lucide: session.pinned ? .pinOff : .pin)
                    }
                }
                Button {
                    Task { await model.change(session, SessionPatch(archived: !session.archived)) }
                } label: {
                    Label { Text(l10n(session.archived ? "chat_controls.unarchive" : "chat_controls.archive")) } icon: {
                        Image(lucide: session.archived ? .archiveRestore : .archive)
                    }
                }
                if let up = SessionOrder.step(session.id, by: -1, shown: list.map(\.id)) {
                    Button { model.setOrder(up) } label: {
                        Label { Text(l10n("session_order.move_up")) } icon: { Image(lucide: .chevronUp) }
                    }
                }
                if let down = SessionOrder.step(session.id, by: 1, shown: list.map(\.id)) {
                    Button { model.setOrder(down) } label: {
                        Label { Text(l10n("session_order.move_down")) } icon: { Image(lucide: .chevronDown) }
                    }
                }
                Button { moving = Keyed(id: session.id, value: session) } label: {
                    Label { Text(l10n("session_groups.categories.move_to")) } icon: { Image(lucide: .folderInput) }
                }
                Button(role: .destructive) { deleting = session } label: {
                    Label { Text(l10n("chat_controls.delete")) } icon: { Image(lucide: .trash) }
                }
            }
        }
        .accessibilityIdentifier("session.\(session.id)")
        .accessibilityAction(named: Text(l10n("sessions.batch_select"))) { model.toggle(session.id) }
    }
}

/// A category being named: a new one (in a profile, maybe to file a chat in at once) or a rename.
struct CategoryNaming: Equatable {
    var title: String
    var profile: String
    var category: SessionCategory? = nil
    var text: String = ""
    var fileAfter: Session? = nil
}

/// "Move to category": the chat's profile's categories, "No category", and a new one.
struct MoveToCategorySheet: View {
    let session: Session
    let categories: [SessionCategory]
    let choose: (String?) -> Void
    let newCategory: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section {
                row(nil, name: l10n("session_groups.categories.none"), colour: nil)
                ForEach(categories.sorted { ($0.position, $0.name) < ($1.position, $1.name) }, id: \.id) { category in
                    row(category.id, name: category.name, colour: category.color)
                }
            } footer: {
                Text(l10n("session_groups.categories.move_hint", ["profile": app.profileName(session.profile)]))
            }
            Section {
                Button {
                    dismiss()
                    newCategory()
                } label: {
                    LucideLabel(l10n("session_groups.categories.new_and_move"), icon: .folderPlus, size: 16)
                }
                .accessibilityIdentifier("move.new")
            }
        }
        .navigationTitle(l10n("session_groups.categories.move_title", ["title": session.title ?? l10n("sessions.untitled")]))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button(l10n("common.close")) { dismiss() } }
        }
    }

    private func row(_ id: String?, name: String, colour: String?) -> some View {
        Button {
            if id != session.categoryId { choose(id) }
            dismiss()
        } label: {
            HStack(spacing: Space.s2) {
                if let dot = SessionGroups.colour(colour) { Circle().fill(dot).frame(width: 8, height: 8) }
                Text(name).foregroundStyle(Tone.text).contentDirection(of: name, fill: false)
                Spacer()
                if id == session.categoryId {
                    Text(l10n("session_groups.categories.current")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                }
            }
        }
        .accessibilityIdentifier("move.\(id ?? "none")")
    }
}

struct ProfileBadge: View {
    let name: String

    var body: some View {
        Text(name)
            .font(.system(size: FontSize.sizeXs, weight: .medium))
            .foregroundStyle(Tone.accentSoftText)
            .lineLimit(1)
            .padding(.horizontal, Space.s2)
            .padding(.vertical, 2)
            .background(Tone.accentSoft, in: Capsule())
    }
}

/// The chats list's batch mode, as pure rules: the list may hold several profiles and each call
/// names one, so a selection goes per profile, at most 100 ids a call (`sessions.bulkDelete`).
enum SessionBatch {
    static let maxPerCall = 100

    static func toggle(_ selected: Set<String>, _ id: String) -> Set<String> {
        var next = selected
        if next.contains(id) { next.remove(id) } else { next.insert(id) }
        return next
    }

    static func byProfile(_ sessions: [Session], _ selected: Set<String>) -> [(String, [String])] {
        var order: [String] = []
        var ids: [String: [String]] = [:]
        for session in sessions where selected.contains(session.id) {
            if ids[session.profile] == nil { order.append(session.profile) }
            ids[session.profile, default: []].append(session.id)
        }
        return order.flatMap { profile -> [(String, [String])] in
            let all = ids[profile] ?? []
            return stride(from: 0, to: all.count, by: maxPerCall).map { start in
                (profile, Array(all[start..<min(start + maxPerCall, all.count)]))
            }
        }
    }

    /// The hub's words for what did not go through (partial success is still a success).
    static func failures(_ results: [BulkResult]) -> [String] {
        results.flatMap(\.results).filter { !$0.ok }.map { $0.error?.error ?? $0.id }
    }
}
