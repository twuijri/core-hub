// The Agents page (destination `agent_manager`) and the pages under an agent (NAVIGATION.md §٤).
// A card per agent from the hub's registry; its chips open that agent's pages directly. On a
// phone the agent's list is a page too, and every page under it starts with «Back to agents»
// and keeps the profile selector in view, because these pages edit one profile's tools.
import CoreHubClient
import SwiftUI

enum AgentRoute: Hashable {
    case menu(agentID: String)
    case page(agentID: String, destination: DestinationID)
}

enum AgentPages {
    /// An agent that is actually here can be configured (web `agents/sections.ts`).
    static func configurable(_ agent: Agent) -> Bool {
        agent.status != .notInstalled && agent.install.source != ._none
    }

    static func menu(for agent: Agent) -> [DestinationID] {
        NavigationMap.agentMenu(capabilities: agent.capabilities.map(\.rawValue), installed: configurable(agent))
    }
}

struct AgentsScreen: View {
    let openMenu: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var path: [AgentRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            // Read again when an agent changed on the hub (`agent.updated` on `/rt/jobs`).
            AsyncContent(key: "\(app.currentProfile)#\(JobsFeed.shared.agentsRevision)") {
                let profile = app.currentProfile
                return try await app.api.call { try await AgentsAPI.agentsList(xHubProfile: profile, apiConfiguration: $0) }.items
            } content: { agents, reload in
                List {
                    ForEach(agents, id: \.id) { agent in
                        AgentCard(agent: agent, open: { path.append($0) }, reload: reload)
                    }
                }
                .refreshable { reload() }
            }
            .navigationTitle(l10n("nav.agent_manager"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: openMenu) { LucideIcon(.menu, size: 20) }
                        .accessibilityLabel(l10n("shell.open_menu"))
                }
            }
            .navigationDestination(for: AgentRoute.self) { route in
                AgentRouteView(route: route, backToAgents: { path.removeAll() }, open: { path.append($0) })
            }
            .accessibilityIdentifier("screen.agent_manager")
        }
    }
}

struct AgentCard: View {
    let agent: Agent
    let open: (AgentRoute) -> Void
    let reload: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            Button { open(.menu(agentID: agent.id)) } label: {
                HStack(spacing: Space.s3) {
                    AgentAvatar(identity: .of(agent), profile: app.currentProfile, size: Layout.avatarMd)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: Space.s2) {
                            Text(agent.name)
                                .font(.system(size: FontSize.sizeMd, weight: .semibold))
                                .foregroundStyle(Tone.text)
                                .lineLimit(1)
                            // On a phone a healthy agent is a dot, not a word (docs/design/family.md).
                            StatusDot(kind: statusKind, label: l10n("agents.status_\(agent.status.rawValue)"))
                        }
                        if let version = agent.install.version {
                            Text(l10n("agents.version", ["version": version]))
                                .font(.system(size: FontSize.sizeXs))
                                .foregroundStyle(Tone.textMuted)
                                .lineLimit(1)
                        }
                        // Where its model calls go (ADR 0029): the hub's providers, or its own
                        // account. An older hub, or an agent the gateway does not wire: nothing.
                        if let key = ChatControls.modelSourceKey(agent) {
                            Text(l10n(key))
                                .font(.system(size: FontSize.sizeXs))
                                .foregroundStyle(Tone.textMuted)
                                .lineLimit(1)
                                .accessibilityIdentifier("agent.model_source")
                        }
                    }
                    Spacer(minLength: Space.s2)
                    if agent.status != .available {
                        StatusPill(text: l10n("agents.status_\(agent.status.rawValue)"), kind: statusPillKind)
                    }
                    if agent.limited { StatusPill(text: l10n("agents.limited"), kind: .warn) }
                    LucideIcon(.chevronRight, size: 16)
                        .foregroundStyle(Tone.textFaint)
                        .flipsForRightToLeftLayoutDirection(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // Capability tags are information, not buttons: one quiet line in the person's words.
            if !agent.capabilities.isEmpty {
                Text(agent.capabilities.map { capabilityName($0.rawValue) }.joined(separator: " · "))
                    .font(.system(size: FontSize.sizeXs))
                    .foregroundStyle(Tone.textMuted)
                    .lineLimit(2)
            }
            FlowLayout(spacing: Space.s2) {
                ForEach(AgentPages.menu(for: agent)) { destination in
                    Button { open(.page(agentID: agent.id, destination: destination)) } label: {
                        HStack(spacing: Space.s1) {
                            LucideIcon(Icons.lucide(for: destination), size: 14)
                            Text(l10n(destination.titleKey))
                        }
                    }
                    .buttonStyle(ChipButtonStyle())
                    .accessibilityLabel(l10n("agents.page_of", ["page": l10n(destination.titleKey), "agent": agent.name]))
                    .accessibilityIdentifier("agent.\(agent.slug).\(destination.rawValue)")
                }
            }
            // Install, update, restart and remove, followed to their end (apps batch 8).
            AgentCardActions(agent: agent, reload: reload)
        }
        .padding(.vertical, Space.s2)
    }

    private var statusKind: StatusDot.Kind {
        switch agent.status {
        case .available: return .good
        case .error: return .bad
        case .installing, .updating, .limited: return .warn
        default: return .neutral
        }
    }

    private var statusPillKind: StatusPill.Kind {
        switch statusKind {
        case .good: return .good
        case .warn: return .warn
        case .bad: return .bad
        case .neutral: return .neutral
        }
    }

    /// A capability in the person's words; the catalog's own name when we have none for it.
    private func capabilityName(_ raw: String) -> String {
        let key = "agents.capability.\(raw)"
        return l10n.has(key) ? l10n(key) : raw
    }
}

/// An agent's menu or one of its pages, found by id in the current profile.
struct AgentRouteView: View {
    let route: AgentRoute
    let backToAgents: () -> Void
    let open: (AgentRoute) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    private var agentID: String {
        switch route {
        case .menu(let id), .page(let id, _): return id
        }
    }

    var body: some View {
        AsyncContent(key: "\(app.currentProfile)/\(agentID)") {
            let profile = app.currentProfile
            let list = try await app.api.call { try await AgentsAPI.agentsList(xHubProfile: profile, apiConfiguration: $0) }
            guard let agent = list.items.first(where: { $0.id == agentID }) else {
                throw HubFailure(kind: .http, status: 404, code: "not_found", message: l10n("agents.gone"), operationID: nil, requestID: nil, detail: "")
            }
            return agent
        } content: { agent, _ in
            VStack(spacing: 0) {
                AgentPageHeader(agent: agent, backToAgents: backToAgents)
                switch route {
                case .menu:
                    List {
                        ForEach(AgentPages.menu(for: agent)) { destination in
                            Button { open(.page(agentID: agent.id, destination: destination)) } label: {
                                LucideLabel(l10n(destination.titleKey), icon: Icons.lucide(for: destination))
                            }
                        }
                    }
                case .page(_, let destination):
                    AgentPage(agent: agent, destination: destination)
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// «Back to agents», the agent's name, and the profile its pages edit (rule 4 of §٤).
struct AgentPageHeader: View {
    let agent: Agent
    let backToAgents: () -> Void
    @Environment(\.l10n) private var l10n

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            Button(action: backToAgents) {
                HStack(spacing: Space.s1) {
                    LucideIcon(.chevronLeft, size: 16).flipsForRightToLeftLayoutDirection(true)
                    Text(l10n("nav.\(NavigationMap.agentBackTerm)"))
                }
                .font(.system(size: FontSize.sizeSm, weight: .medium))
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityIdentifier("agent.back")
            HStack {
                Text(agent.name).font(.system(size: FontSize.sizeLg, weight: .semibold))
                Spacer()
            }
            ProfileSelector()
        }
        .padding(.horizontal, Space.s4)
        .padding(.vertical, Space.s2)
    }
}

struct AgentPage: View {
    let agent: Agent
    let destination: DestinationID
    @Environment(\.l10n) private var l10n

    var body: some View {
        // Each page registers itself from its own file (Pages/PhonePage.swift).
        RegisteredPage(destination: destination, agent: agent)
            .navigationTitle(l10n(destination.titleKey))
            .accessibilityIdentifier("screen.\(destination.rawValue)")
    }
}
