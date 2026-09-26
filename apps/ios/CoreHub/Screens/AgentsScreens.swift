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
            AsyncContent(key: app.currentProfile) {
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
    @State private var restarting = false
    @State private var error: String?

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
                if agent.runtime.state != .notApplicable {
                    Button {
                        Task { await restart() }
                    } label: {
                        HStack(spacing: Space.s1) {
                            LucideIcon(.rotateCw, size: 14)
                                .rotationEffect(.degrees(restarting ? 360 : 0))
                                .animation(restarting ? .linear(duration: 1).repeatForever(autoreverses: false) : .default, value: restarting)
                            Text(l10n("agents.restart"))
                        }
                    }
                    .buttonStyle(ChipButtonStyle(quiet: true))
                    .disabled(restarting)
                }
            }
            if let error { NoticeView(text: error, tone: .danger) }
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

    private func restart() async {
        restarting = true
        defer { restarting = false }
        let profile = app.currentProfile
        do {
            _ = try await app.api.call { try await AgentsAPI.agentsRestart(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }
            error = nil
            reload()
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
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
        Group {
            switch destination {
            case .agentSkills: AgentSkillsPage(agent: agent)
            case .agentMcp: AgentMcpPage(agent: agent)
            case .agentMemory: AgentMemoryPage(agent: agent)
            case .agentJobs: AgentJobsPage(agent: agent)
            case .agentChannels: AgentChannelsLinkPage(agent: agent)
            case .agentPlugins: AgentPluginsPage(agent: agent)
            case .agentConfigFiles: AgentConfigFilesPage(agent: agent)
            case .agentSettings: AgentSettingsEditPage(agent: agent)
            default: PlaceholderScreen(destination: destination)
            }
        }
        .navigationTitle(l10n(destination.titleKey))
        .accessibilityIdentifier("screen.\(destination.rawValue)")
    }
}

struct AgentSkillsPage: View {
    let agent: Agent
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var error: String?

    var body: some View {
        AsyncContent(key: app.currentProfile) {
            let profile = app.currentProfile
            return try await app.api.call { try await AgentsAPI.agentsListSkills(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }
        } content: { list, reload in
            List {
                if let error { NoticeView(text: error, tone: .danger) }
                if list.categories.allSatisfy({ $0.skills.isEmpty }) {
                    EmptyRow(icon: .sparkles)
                }
                ForEach(list.categories, id: \.key) { category in
                    Section(category.name) {
                        ForEach(category.skills, id: \.key) { skill in
                            Toggle(isOn: Binding(get: { skill.enabled }, set: { value in
                                Task { await set(skill, enabled: value, reload: reload) }
                            })) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(skill.name)
                                    if let description = skill.description {
                                        Text(description).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted).lineLimit(2)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .refreshable { reload() }
        }
    }

    private func set(_ skill: Skill, enabled: Bool, reload: @escaping () -> Void) async {
        let profile = app.currentProfile
        do {
            _ = try await app.api.call {
                try await AgentsAPI.agentsUpdateSkill(xHubProfile: profile, agentId: agent.id, skillKey: skill.key, skillPatch: SkillPatch(enabled: enabled), apiConfiguration: $0)
            }
            error = nil
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
        reload()
    }
}

struct AgentMcpPage: View {
    let agent: Agent
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var results: [String: String] = [:]

    var body: some View {
        AsyncContent(key: app.currentProfile) {
            let profile = app.currentProfile
            return try await app.api.call { try await AgentsAPI.agentsListMcpServers(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }.items
        } content: { servers, reload in
            List {
                if servers.isEmpty { EmptyRow(icon: .server) }
                ForEach(servers, id: \.name) { server in
                    VStack(alignment: .leading, spacing: Space.s1) {
                        HStack {
                            Text(server.name).font(.system(size: FontSize.sizeMd, weight: .medium))
                            Spacer()
                            StatusPill(text: server.connected ? l10n("mcp.connected") : (server.enabled ? l10n("mcp.not_connected") : l10n("common.off")), kind: server.connected ? .good : .neutral)
                        }
                        Text(l10n("mcp.tools", ["count": String(server.tools.count)]))
                            .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                        if let error = server.error { NoticeView(text: error, tone: .danger) }
                        if let result = results[server.name] { NoticeView(text: result, tone: .info) }
                        Button(l10n("mcp.test")) { Task { await test(server) } }
                            .font(.system(size: FontSize.sizeSm))
                    }
                }
            }
            .refreshable { reload() }
        }
    }

    private func test(_ server: McpServer) async {
        let profile = app.currentProfile
        do {
            let result = try await app.api.call {
                try await AgentsAPI.agentsTestMcpServer(xHubProfile: profile, agentId: agent.id, serverName: server.name, apiConfiguration: $0)
            }
            results[server.name] = result.ok
                ? l10n("mcp.test_ok", ["count": String(result.tools.count)])
                : (result.error ?? l10n("mcp.test_failed"))
        } catch {
            results[server.name] = HubFailure(error).describe(l10n)
        }
    }
}

struct AgentMemoryPage: View {
    let agent: Agent
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: app.currentProfile) {
            let profile = app.currentProfile
            return try await app.api.call { try await AgentsAPI.agentsListMemory(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }.items
        } content: { items, reload in
            List {
                if items.isEmpty { EmptyRow(icon: .brain) }
                ForEach(items, id: \.id) { item in
                    NavigationLink {
                        MemoryEditor(agent: agent, item: item, saved: reload)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title)
                            if let content = item.content {
                                Text(content).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted).lineLimit(2)
                                    .contentDirection(of: content)
                            }
                        }
                    }
                }
            }
            .refreshable { reload() }
        }
    }
}

struct MemoryEditor: View {
    let agent: Agent
    let item: MemoryItem
    let saved: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: Space.s2) {
            if let error { NoticeView(text: error, tone: .danger) }
            TextEditor(text: $text)
                .font(.system(size: FontSize.sizeSm, design: .monospaced))
                .contentDirection(of: text)
                .padding(Space.s2)
                .background(Tone.surface, in: RoundedRectangle(cornerRadius: Radius.md))
        }
        .padding(Space.s3)
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(l10n("common.save")) { Task { await save() } }.disabled(busy)
            }
        }
        .onAppear { text = item.content ?? "" }
    }

    private func save() async {
        busy = true
        defer { busy = false }
        let profile = app.currentProfile
        let write = MemoryItemWrite(title: item.title, content: text, tags: item.tags, revision: item.revision)
        do {
            _ = try await app.api.call {
                try await AgentsAPI.agentsPutMemoryItem(xHubProfile: profile, agentId: agent.id, itemId: item.id, memoryItemWrite: write, apiConfiguration: $0)
            }
            saved()
            dismiss()
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }
}

/// The agent's jobs: the Schedules list narrowed to this agent and profile (§٤ rule 8).
struct AgentJobsPage: View {
    let agent: Agent
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: app.currentProfile) {
            let profile = app.currentProfile
            return try await app.api.call {
                try await SchedulesAPI.schedulesList(profile: profile, agentId: agent.id, apiConfiguration: $0)
            }.items
        } content: { schedules, reload in
            List {
                if schedules.isEmpty { EmptyRow(icon: .rotateCcwClock) }
                ForEach(schedules, id: \.id) { schedule in
                    ScheduleRow(schedule: schedule, showProfile: false, changed: reload)
                }
            }
            .refreshable { reload() }
        }
    }
}

struct AgentChannelsPage: View {
    let agent: Agent
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: app.currentProfile) {
            let profile = app.currentProfile
            return try await app.api.call { try await AgentsAPI.agentsListChannels(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }.items
        } content: { channels, reload in
            List {
                Section {
                    Text(l10n("channels.link_on_web")).font(.system(size: FontSize.sizeSm)).foregroundStyle(Tone.textMuted)
                }
                ForEach(channels, id: \.platform) { channel in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(channel.label)
                            Spacer()
                            StatusPill(text: l10n("channels.status_\(channel.status.rawValue)"), kind: channel.status == .online ? .good : channel.status == .error ? .bad : .neutral)
                        }
                        if let error = channel.error { Text(error).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.danger) }
                    }
                }
            }
            .refreshable { reload() }
        }
    }
}

struct AgentPluginsPage: View {
    let agent: Agent
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var error: String?

    var body: some View {
        AsyncContent(key: app.currentProfile) {
            let profile = app.currentProfile
            return try await app.api.call { try await AgentsAPI.agentsListPlugins(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }
        } content: { list, reload in
            List {
                if let error { NoticeView(text: error, tone: .danger) }
                ForEach(list.warnings, id: \.self) { warning in NoticeView(text: warning, tone: .warning) }
                if list.items.isEmpty { EmptyRow(icon: .puzzle) }
                ForEach(list.items, id: \.key) { plugin in
                    Toggle(isOn: Binding(get: { plugin.enabled }, set: { value in
                        Task { await set(plugin, enabled: value, reload: reload) }
                    })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(plugin.name)
                            Text(plugin.status.rawValue.replacingOccurrences(of: "_", with: " "))
                                .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                        }
                    }
                    .disabled(!plugin.manageable)
                }
            }
            .refreshable { reload() }
        }
    }

    private func set(_ plugin: AgentPlugin, enabled: Bool, reload: @escaping () -> Void) async {
        let profile = app.currentProfile
        do {
            _ = try await app.api.call {
                try await AgentsAPI.agentsUpdatePlugin(xHubProfile: profile, agentId: agent.id, pluginKey: plugin.key, agentsUpdatePluginRequest: AgentsUpdatePluginRequest(enabled: enabled), apiConfiguration: $0)
            }
            error = nil
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
        reload()
    }
}

/// The adapter's own settings descriptor (ADR 0002): sections and fields, in the person's
/// language. Toggles change here; the other kinds are read here and edited on the web.
struct AgentSettingsPage: View {
    let agent: Agent
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var error: String?

    var body: some View {
        AsyncContent(key: app.currentProfile) {
            let profile = app.currentProfile
            return try await app.api.call { try await AgentsAPI.agentsGetSettings(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }
        } content: { settings, reload in
            List {
                if let error { NoticeView(text: error, tone: .danger) }
                ForEach(settings.sections, id: \.key) { section in
                    Section(text(section.title)) {
                        ForEach(section.fields, id: \.key) { field in
                            if field.kind == .toggle, case .bool(let on)? = field.value {
                                Toggle(text(field.label), isOn: Binding(get: { on }, set: { value in
                                    Task { await set(section: section.key, field: field.key, value: .bool(value), reload: reload) }
                                }))
                            } else {
                                FactRow(label: text(field.label), value: field.kind == .secret ? "••••" : field.value.map(JSONText.scalar) ?? "—")
                            }
                        }
                    }
                }
            }
            .refreshable { reload() }
        }
    }

    private func text(_ localized: LocalizedText) -> String {
        app.language == .ar ? localized.ar : localized.en
    }

    private func set(section: String, field: String, value: JSONValue, reload: @escaping () -> Void) async {
        let profile = app.currentProfile
        do {
            _ = try await app.api.call {
                try await AgentsAPI.agentsUpdateSettings(xHubProfile: profile, agentId: agent.id, agentSettingsPatch: AgentSettingsPatch(section: section, values: [field: value]), apiConfiguration: $0)
            }
            error = nil
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
        reload()
    }
}
