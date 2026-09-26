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

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var listener: UUID?
    @ObservationIgnored private var reloadTask: Task<Void, Never>?
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

    func start() {
        guard listener == nil, let namespace = app?.sessions else {
            reload()
            return
        }
        listener = namespace.onEvent { [weak self] name, argument in
            guard name.hasPrefix("session.") else { return }
            _ = argument
            self?.scheduleReload()
        }
        reload()
    }

    func stop() {
        if let listener { app?.sessions?.remove(listener) }
        listener = nil
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
        loading = true
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
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var confirmingDelete = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            controls
            if model.selecting { batchBar }
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
            if !model.pinned.isEmpty {
                section(l10n("sessions.pinned"), model.pinned)
            }
            if !model.recent.isEmpty {
                section(l10n("sessions.recent") + " · \(model.recent.count)", model.recent)
            }
        }
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            HStack(spacing: Space.s2) {
                Image(systemName: "magnifyingglass").foregroundStyle(Tone.textFaint)
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
                Button { model.clearSelection() } label: { Image(systemName: "xmark") }
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
                Image(systemName: "chevron.down").font(.system(size: FontSize.sizeXs))
            }
            .font(.system(size: FontSize.sizeSm))
            .padding(.horizontal, Space.s2)
            .frame(height: Control.heightSm)
            .background(Tone.surface2, in: Capsule())
        }
        .accessibilityIdentifier("sessions.profile_filter")
    }

    private func section(_ title: String, _ sessions: [Session]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: FontSize.sizeXs, weight: .semibold))
                .foregroundStyle(Tone.textFaint)
                .padding(.top, Space.s2)
            ForEach(sessions, id: \.id) { session in
                row(session)
            }
        }
    }

    private func row(_ session: Session) -> some View {
        let title = session.title ?? l10n("sessions.untitled")
        let chosen = model.selected.contains(session.id)
        return Button {
            if model.selecting { model.toggle(session.id) } else { open(session) }
        } label: {
            HStack(spacing: Space.s2) {
                if model.selecting {
                    Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(chosen ? Tone.accent : Tone.textFaint)
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
        // A long press offers Select, which starts batch mode with this conversation in it.
        .contextMenu {
            Button { model.toggle(session.id) } label: {
                Label(l10n("sessions.batch_select"), systemImage: "checkmark.circle")
            }
        }
        .accessibilityIdentifier("session.\(session.id)")
        .accessibilityAction(named: Text(l10n("sessions.batch_select"))) { model.toggle(session.id) }
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
