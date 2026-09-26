// The screen id of every destination on iOS (`surfaceRoutes.ios` in navigation.json) and of
// the two pre-auth screens. They are also the paths of `corehub://open/<path>` links, the same
// shape the web and the desktop app use, so a link made for one opens the same page on another.
import Foundation

enum AppRoutes {
    static let routes: [DestinationID: String] = [
        .newChat: "/new",
        .search: "/search",
        .deviceConnections: "/settings/devices",
        .agentManager: "/agents",
        .models: "/settings/models",
        .knowledge: "/settings/knowledge",
        .chat: "/chat/:sessionId?",
        .rooms: "/rooms/:roomId?",
        .tasks: "/tasks",
        .schedules: "/schedules",
        .settings: "/settings",
        .account: "/settings/account",
        .users: "/settings/users",
        .webhooks: "/settings/webhooks",
        .display: "/settings/display",
        .notifications: "/settings/notifications",
        .privacy: "/settings/privacy",
        .thisDevice: "/settings/this-device",
        .about: "/settings/about",
        .logs: "/settings/logs",
        .usage: "/settings/usage",
        .skillsUsage: "/settings/skills-usage",
        .performance: "/settings/performance",
        .theme: "/settings/theme",
        .workspaces: "/settings/workspaces",
        .updates: "/settings/updates",
        .plugins: "/settings/plugins",
        .files: "/settings/files",
        .agentSkills: "/agents/:agentId/skills",
        .agentMcp: "/agents/:agentId/mcp",
        .agentMemory: "/agents/:agentId/memory",
        .agentJobs: "/agents/:agentId/jobs",
        .agentChannels: "/agents/:agentId/channels",
        .agentPlugins: "/agents/:agentId/plugins",
        .agentSettings: "/agents/:agentId/settings",
        .globalAgent: "/global-agent",
    ]

    /// `preAuth`: sign-in and first-run setup, which are not destinations.
    static let preAuth: [String: String] = ["login": "/login", "setup": "/setup"]

    /// The destination a path opens, with its parameters; `nil` for anything else.
    static func match(_ rawPath: String) -> (destination: DestinationID, params: [String: String])? {
        let path = rawPath.split(separator: "?").first.map(String.init) ?? rawPath
        let parts = path.split(separator: "/").map(String.init)
        // The most specific pattern wins: more literal segments first.
        let ordered = routes.sorted { literalCount($0.value) > literalCount($1.value) }
        for (destination, pattern) in ordered {
            if let params = matchPattern(pattern, parts) { return (destination, params) }
        }
        return nil
    }

    private static func literalCount(_ pattern: String) -> Int {
        pattern.split(separator: "/").filter { !$0.hasPrefix(":") }.count
    }

    private static func matchPattern(_ pattern: String, _ parts: [String]) -> [String: String]? {
        let segments = pattern.split(separator: "/").map(String.init)
        var params: [String: String] = [:]
        var index = 0
        for segment in segments {
            let optional = segment.hasSuffix("?")
            if segment.hasPrefix(":") {
                let name = String(segment.dropFirst().dropLast(optional ? 1 : 0))
                if index < parts.count {
                    params[name] = parts[index]
                    index += 1
                } else if !optional {
                    return nil
                }
            } else {
                guard index < parts.count, parts[index] == segment else { return nil }
                index += 1
            }
        }
        return index == parts.count ? params : nil
    }
}
