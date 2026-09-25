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

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            controls
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
        return Button {
            open(session)
        } label: {
            HStack(spacing: Space.s2) {
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
                selected == session.id ? Tone.surface2 : Color.clear,
                in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("session.\(session.id)")
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
