// The app's navigation registry, one-to-one with docs/clients/navigation.json (NAVIGATION.md).
// Every entry list here is the manifest's list in the manifest's order; the parity test reads
// the manifest itself and fails on the first difference.
import CoreHubClient
import Foundation

enum DestinationID: String, CaseIterable, Hashable, Identifiable {
    case newChat = "new_chat"
    case search
    case deviceConnections = "device_connections"
    case agentManager = "agent_manager"
    case models
    case knowledge
    case chat
    case rooms
    case tasks
    case schedules
    case settings
    case account
    case users
    case webhooks
    case display
    case notifications
    case privacy
    case thisDevice = "this_device"
    case about
    case logs
    case usage
    case skillsUsage = "skills_usage"
    case performance
    case theme
    case workspaces
    case updates
    case plugins
    case files
    case agentSkills = "agent_skills"
    case agentMcp = "agent_mcp"
    case agentMemory = "agent_memory"
    case agentJobs = "agent_jobs"
    case agentChannels = "agent_channels"
    case agentPlugins = "agent_plugins"
    case agentSettings = "agent_settings"
    case globalAgent = "global_agent"

    var id: String { rawValue }

    /// The `terms` key of the screen's title; the entry that opens it shows the same key.
    var titleTerm: String {
        switch self {
        case .agentSkills: return "skills"
        case .agentMcp: return "mcp"
        case .agentMemory: return "memory"
        case .agentJobs: return "jobs"
        case .agentChannels: return "channels"
        case .agentPlugins: return "plugins"
        default: return rawValue
        }
    }

    /// The locale key of the title (`nav.<term>`).
    var titleKey: String { "nav.\(titleTerm)" }

    /// Owners and admins only (`roles: ["admin"]`).
    var adminOnly: Bool {
        switch self {
        case .agentManager, .users, .webhooks, .logs, .performance, .workspaces, .updates, .plugins, .files,
             .agentSkills, .agentMcp, .agentMemory, .agentJobs, .agentChannels, .agentPlugins, .agentSettings:
            return true
        default:
            return false
        }
    }

    /// The adapter capability an agent-level page needs (`capability`); the client never
    /// decides it (NAVIGATION.md rule 3).
    var capability: String? {
        switch self {
        case .agentSkills: return "skills"
        case .agentMcp: return "mcp"
        case .agentMemory: return "memory"
        case .agentJobs: return "jobs"
        case .agentChannels: return "channels"
        case .agentPlugins: return "plugins"
        case .agentSettings: return "settings"
        default: return nil
        }
    }

    /// Screens outside any profile say so (users, updates, performance).
    var isGlobal: Bool { self == .users || self == .performance || self == .updates }
}

enum NavigationMap {
    static let rail: [DestinationID] = [.newChat, .search, .agentManager, .tasks, .schedules]
    static let segments: [DestinationID] = [.chat, .rooms]
    static let footer: [DestinationID] = [.settings]
    static let settingsTabs: [DestinationID] = [.account, .users, .webhooks, .display, .notifications, .privacy, .thisDevice, .about]
    static let settingsManagement: [DestinationID] = [.models, .deviceConnections, .knowledge]
    static let settingsTools: [DestinationID] = [
        .logs, .usage, .skillsUsage, .performance, .theme, .workspaces, .updates, .plugins, .files,
    ]
    static let agentLevel: [DestinationID] = [.agentSkills, .agentMcp, .agentMemory, .agentJobs, .agentChannels, .agentPlugins, .agentSettings]
    /// Reached only from these entries (`secondaryEntries`).
    static let secondaryEntries: [DestinationID: [DestinationID]] = [.chat: [.search], .globalAgent: [.search]]
    /// The pre-auth screens (`preAuth`): not destinations.
    static let preAuth: [String] = ["login", "setup"]
    /// The back row inside an agent's pages (`agentShell`).
    static let agentBackTerm = "back_to_agents"

    /// Entries a person with this role sees, in order.
    static func visible(_ list: [DestinationID], admin: Bool) -> [DestinationID] {
        list.filter { admin || !$0.adminOnly }
    }

    /// An agent's menu: only what its adapter declares, in `agentLevel` order; Settings for
    /// every installed agent (navigation.json note on `agent_settings`).
    static func agentMenu(capabilities: [String], installed: Bool) -> [DestinationID] {
        agentLevel.filter { destination in
            guard let capability = destination.capability else { return false }
            if destination == .agentSettings { return installed || capabilities.contains(capability) }
            return capabilities.contains(capability)
        }
    }
}
