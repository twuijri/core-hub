// Search (destination `search`): a sheet over every conversation in every profile the person
// may enter (profileScope.alwaysAll), its field focused at once. A hit opens its conversation
// in its own profile — the one secondary entry to `chat` — or the global agent's page.
import CoreHubClient
import SwiftUI

struct SearchScreen: View {
    let openChat: (Session) -> Void
    let openGlobalAgent: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [Session] = []
    @State private var searching = false
    @State private var error: String?
    /// The field is focused the moment the sheet opens.
    @State private var searchActive = false

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    NoticeView(text: error, tone: .danger)
                }
                if !query.isEmpty && results.isEmpty && !searching && error == nil {
                    Text(l10n("sessions.empty_filtered")).foregroundStyle(Tone.textMuted)
                }
                ForEach(results, id: \.id) { session in
                    Button {
                        dismiss()
                        if session.source == .globalAgent { openGlobalAgent() } else { openChat(session) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(session.source == .globalAgent ? l10n("nav.global_agent") : (session.title ?? l10n("sessions.untitled")))
                                    .font(.system(size: FontSize.sizeMd, weight: .medium))
                                    .foregroundStyle(Tone.text)
                                Spacer()
                                if app.enterableProfiles.count > 1 {
                                    ProfileBadge(name: app.profileName(session.profile))
                                }
                            }
                            if let snippet = session.match?.snippet ?? session.preview {
                                Text(snippet)
                                    .font(.system(size: FontSize.sizeSm))
                                    .foregroundStyle(Tone.textMuted)
                                    .lineLimit(2)
                                    .contentDirection(of: snippet)
                            }
                        }
                    }
                    .accessibilityIdentifier("search.result")
                }
            }
            .listStyle(.plain)
            .searchable(text: $query, isPresented: $searchActive, placement: .navigationBarDrawer(displayMode: .always), prompt: l10n("sessions.search_placeholder"))
            .onSubmit(of: .search) { Task { await search() } }
            .task(id: query) {
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else { return }
                await search()
            }
            .onAppear { searchActive = true }
            .navigationTitle(l10n("nav.search"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(l10n("common.close")) { dismiss() }
                }
            }
            .accessibilityIdentifier("screen.search")
        }
    }

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            results = []
            error = nil
            return
        }
        searching = true
        defer { searching = false }
        let header = app.currentProfile
        do {
            let page = try await app.api.call {
                try await SessionsAPI.sessionsList(
                    xHubProfile: header, profiles: .all, archived: .all, q: q, limit: 50, apiConfiguration: $0
                )
            }
            results = page.items
            error = nil
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }
}

/// The global agent (destination `global_agent`): the person's one standing conversation in
/// the profile, opened (and made on first use) by the hub. No menu entry: search leads here.
struct GlobalAgentScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: app.currentProfile) {
            try await open()
        } content: { session, _ in
            ChatScreen(model: ChatModel(app: app, sessionID: session.id, profile: session.profile), fixedTitle: l10n("nav.global_agent"))
                .id(session.id)
        }
        .navigationTitle(l10n("nav.global_agent"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("screen.global_agent")
    }

    private func open() async throws -> Session {
        let profile = app.currentProfile
        guard let agent = app.agents.first(where: { $0.enabled && $0.status == .available }) ?? app.agents.first else {
            throw HubFailure(kind: .http, status: 409, code: nil, message: l10n("chat.no_agent"), operationID: nil, requestID: nil, detail: "")
        }
        return try await app.api.call {
            try await SessionsAPI.sessionsOpenGlobalAgent(
                xHubProfile: profile, globalAgentOpen: GlobalAgentOpen(agentId: agent.id), apiConfiguration: $0
            )
        }
    }
}
