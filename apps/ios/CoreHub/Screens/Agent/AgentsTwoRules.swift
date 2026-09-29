// The rules of an agent's MCP servers, Settings cards and Channels pages (apps batch 9, Agents II),
// apart from the views so they are tested without drawing. They follow the web's agents/AgentMcpScreen,
// HubToolsCard, AgentSettingsScreen, CompressionSettingsCard, AgentChannelsScreen, ChannelSettingsPanel
// and webhooks.ts; Android's AgentsTwoRules.kt is the twin.
import CoreHubClient
import Foundation

enum JSONCoding {
    /// A value as pretty JSON text, keys sorted.
    static func text(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// The text as JSON, or nil while it is not.
    static func parse(_ text: String) -> JSONValue? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    static func string(_ value: JSONValue?) -> String {
        switch value {
        case .string(let s)?: return s
        case .int(let i)?: return String(i)
        case .double(let d)?: return d.rounded() == d && abs(d) < 1e15 ? String(Int(d)) : String(d)
        case .bool(let b)?: return b ? "true" : "false"
        case .null?, nil: return ""
        case .array(let items)?: return items.map { string($0) }.joined(separator: ", ")
        case .dictionary?: return text(value!)
        }
    }
}

/// An MCP server edited as a form (a command or an address) or, for anything else, as its JSON.
enum McpRules {
    static let stored = "[stored]"
    private static let formKeys: Set<String> = ["command", "args", "env", "url", "headers", "enabled"]

    static func validName(_ name: String) -> Bool {
        name.range(of: "^[A-Za-z0-9._-]{1,60}$", options: .regularExpression) != nil
    }

    enum Kind: String, CaseIterable, Identifiable { case command, url; var id: String { rawValue } }

    /// One variable or header: its name, what was typed, and whether the hub holds a value already.
    struct Row: Equatable, Identifiable {
        var id = UUID()
        var key = ""
        var value = ""
        var stored = false
        static func == (a: Row, b: Row) -> Bool { a.key == b.key && a.value == b.value && a.stored == b.stored }
    }

    struct Draft: Equatable {
        var kind: Kind = .command
        var command = ""
        /// One argument per line.
        var args = ""
        var env: [Row] = []
        var url = ""
        var headers: [Row] = []
        /// Every other key of the server, kept as it is.
        var rest: [String: JSONValue] = [:]
    }

    enum Problem: Equatable { case commandRequired, urlBad, rowBad }

    /// What a new server starts as (the web's template).
    static let template = Draft(command: "npx", args: "-y\nsome-mcp-server")

    private static func rows(_ value: JSONValue?) -> [Row] {
        guard case .dictionary(let object)? = value else { return [] }
        return object.keys.sorted().map { key in
            let shown = JSONCoding.string(object[key])
            return shown == stored ? Row(key: key, value: "", stored: true) : Row(key: key, value: shown)
        }
    }

    private static func isURL(_ config: [String: JSONValue]) -> Bool {
        if case .string? = config["url"], config["command"] == nil { return true }
        return false
    }

    /// The form for a stored config; `enabled` is the row's switch, not a field.
    static func draft(_ config: [String: JSONValue]) -> Draft {
        var args = JSONCoding.string(config["args"])
        if case .array(let items)? = config["args"] { args = items.map { JSONCoding.string($0) }.joined(separator: "\n") }
        return Draft(
            kind: isURL(config) ? .url : .command,
            command: JSONCoding.string(config["command"]),
            args: args,
            env: rows(config["env"]),
            url: JSONCoding.string(config["url"]),
            headers: rows(config["headers"]),
            rest: config.filter { !formKeys.contains($0.key) }
        )
    }

    private static func block(_ rows: [Row]) -> JSONValue? {
        let kept = rows.filter { !$0.key.trimmingCharacters(in: .whitespaces).isEmpty }
        guard !kept.isEmpty else { return nil }
        var object: [String: JSONValue] = [:]
        for row in kept { object[row.key.trimmingCharacters(in: .whitespaces)] = .string(row.stored && row.value.isEmpty ? stored : row.value) }
        return .dictionary(object)
    }

    /// The config the form means: the kept keys, then what the form says for its kind.
    static func config(_ draft: Draft) -> [String: JSONValue] {
        var config = draft.rest
        switch draft.kind {
        case .command:
            config["command"] = .string(draft.command.trimmingCharacters(in: .whitespaces))
            let args = draft.args.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            if !args.isEmpty { config["args"] = .array(args.map(JSONValue.string)) }
            if let env = block(draft.env) { config["env"] = env }
        case .url:
            config["url"] = .string(draft.url.trimmingCharacters(in: .whitespaces))
            if let headers = block(draft.headers) { config["headers"] = headers }
        }
        return config
    }

    private static func badRow(_ row: Row) -> Bool {
        let key = row.key.trimmingCharacters(in: .whitespaces)
        if key.isEmpty { return !row.value.trimmingCharacters(in: .whitespaces).isEmpty }
        return key.contains { $0.isWhitespace || $0 == "=" || $0 == ":" }
    }

    /// Why the form cannot be saved yet, or nil.
    static func problem(_ draft: Draft) -> Problem? {
        switch draft.kind {
        case .command:
            if draft.command.trimmingCharacters(in: .whitespaces).isEmpty { return .commandRequired }
            return draft.env.contains(where: badRow) ? .rowBad : nil
        case .url:
            if draft.url.trimmingCharacters(in: .whitespaces).range(of: "^https?://\\S+$", options: .regularExpression) == nil { return .urlBad }
            return draft.headers.contains(where: badRow) ? .rowBad : nil
        }
    }

    /// The shape decides, as on the web: an address is a socket, a command a process.
    static func transport(_ config: [String: JSONValue]) -> McpServerWrite.Transport { isURL(config) ? .http : .stdio }

    /// The transport to send with an edit: only when the form moved between a command and an address.
    static func transportChange(_ server: McpServer, _ config: [String: JSONValue]) -> McpServerPatch.Transport? {
        let nowAddress = isURL(config), wasAddress = server.transport != .stdio
        if nowAddress == wasAddress { return nil }
        return nowAddress ? .http : .stdio
    }

    static func json(_ config: [String: JSONValue]) -> String { JSONCoding.text(.dictionary(config.filter { $0.key != "enabled" })) }

    /// The text as a config: a JSON object, or nil while it is not one.
    static func parse(_ text: String) -> [String: JSONValue]? {
        if case .dictionary(let object)? = JSONCoding.parse(text) { return object }
        return nil
    }

    /// One line a person recognises the server by: what it runs, or where it points.
    static func summary(_ server: McpServer) -> String {
        if case .string(let url)? = server.config["url"] { return url }
        let command = JSONCoding.string(server.config["command"])
        var args = ""
        if case .array(let items)? = server.config["args"] { args = items.map { JSONCoding.string($0) }.joined(separator: " ") }
        return [command, args].filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// The servers the page lists: not the hub's own block, which its card manages (decision §67).
    static func listed(_ servers: [McpServer], hubServer: String?) -> [McpServer] { servers.filter { $0.name != (hubServer ?? "corehub") } }

    /// "0.8" seconds from a test's milliseconds, with a point whatever the language.
    /// Whether Hermes gives the agent `name` under a server's `tools.include` / `tools.exclude`
    /// (DECISIONS §134): the allow-list wins, then the block-list; entries are names or globs.
    static func allowed(_ name: String, include: [String]?, exclude: [String]?) -> Bool {
        if let include { return include.contains { matches(name, $0) } }
        if let exclude { return !exclude.contains { matches(name, $0) } }
        return true
    }

    /// An exact name, or a glob (`*`, `?`, `[…]`) matched as Hermes's `fnmatch` does.
    static func matches(_ name: String, _ entry: String) -> Bool {
        if entry == name { return true }
        guard entry.contains(where: { "*?[".contains($0) }) else { return false }
        return fnmatch(entry, name, 0) == 0
    }

    /// The folded row's count from the kept test: every tool, or how many of them the filter allows.
    static func toolCount(_ names: [String], include: [String]?, exclude: [String]?) -> (allowed: Int, total: Int, filtered: Bool) {
        let filtered = include != nil || exclude != nil
        let allowed = names.filter { Self.allowed($0, include: include, exclude: exclude) }.count
        return (allowed, names.count, filtered)
    }

    static func seconds(_ ms: Int) -> String { String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), Double(ms) / 1000) }
}

/// An agent's own settings as the phone edits them: `list` one item per line, `json` that parses.
enum SettingsCardRules {
    static func listText(_ value: JSONValue?) -> String {
        if case .array(let items)? = value { return items.map { JSONCoding.string($0) }.joined(separator: "\n") }
        return JSONCoding.string(value)
    }

    static func listValue(_ text: String) -> JSONValue {
        let items = text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return items.isEmpty ? .null : .array(items.map(JSONValue.string))
    }

    static func jsonText(_ value: JSONValue?) -> String {
        guard let value, value != .null else { return "" }
        return JSONCoding.text(value)
    }

    /// The typed JSON, `.null` for empty (the default back), or nil while it is not JSON.
    static func jsonValue(_ text: String) -> JSONValue? {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .null : JSONCoding.parse(text)
    }

    enum Saved: Equatable { case restarting, restartNeeded, nextMessage, saved }

    static func saved(restartJobId: String?, applies: SettingsSection.Applies?) -> Saved {
        if restartJobId != nil { return .restarting }
        switch applies {
        case .restart?: return .restartNeeded
        case .nextMessage?: return .nextMessage
        default: return .saved
        }
    }
}

/// Context compression (decision §57): whole percentages on screen, ratios on the wire.
enum CompressionRules {
    struct Draft: Equatable {
        var enabled: Bool
        var threshold: String
        var target: String
        var protectFirst: String
        var protectLast: String
        var contextLength: String
    }

    enum Field: String, Equatable { case threshold, target, protectFirst, protectLast, contextLength }

    static func draft(_ c: ProfileSettingsCompression) -> Draft {
        Draft(enabled: c.enabled, threshold: String(Int((c.threshold * 100).rounded())), target: String(Int((c.targetRatio * 100).rounded())),
              protectFirst: String(c.protectFirst), protectLast: String(c.protectLast), contextLength: c.contextLength.map(String.init) ?? "")
    }

    private static func whole(_ text: String) -> Int? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, t.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return Int(t)
    }

    /// The patch the draft means, or the first field that is not a valid number.
    static func patch(_ d: Draft) -> Result<[String: JSONValue], FieldError> {
        guard let threshold = whole(d.threshold), (1...100).contains(threshold) else { return .failure(FieldError(field: .threshold)) }
        guard let target = whole(d.target), (1...100).contains(target) else { return .failure(FieldError(field: .target)) }
        guard let first = whole(d.protectFirst) else { return .failure(FieldError(field: .protectFirst)) }
        guard let last = whole(d.protectLast) else { return .failure(FieldError(field: .protectLast)) }
        var window: JSONValue = .null
        if !d.contextLength.trimmingCharacters(in: .whitespaces).isEmpty {
            guard let n = whole(d.contextLength), n >= 1024 else { return .failure(FieldError(field: .contextLength)) }
            window = .int(n)
        }
        return .success([
            "enabled": .bool(d.enabled), "threshold": .double(Double(threshold) / 100), "target_ratio": .double(Double(target) / 100),
            "protect_first": .int(first), "protect_last": .int(last), "context_length": window,
        ])
    }

    struct FieldError: Error, Equatable { let field: Field }
}

/// An agent's Channels page, as the web's.
enum ChannelRules {
    /// Only what is linked, or what somebody waits on; Hermes's webhook receiver has its own section.
    static func shown(_ items: [Channel], pending: [PairingRequest]) -> [Channel] {
        let waiting = Set(pending.map(\.platform))
        return items.filter { c in c.platform != "webhook" && ((c.link?.linked ?? c.configured) || waiting.contains(c.platform)) }
    }

    static func waitingOn(_ pending: [PairingRequest], _ platform: String) -> Int { pending.filter { $0.platform == platform }.count }

    static func linked(_ channel: Channel) -> Bool { channel.link?.linked == true }

    /// WhatsApp's mode once linked; nil for every other platform.
    static func mode(_ channel: Channel) -> ChannelLink.Mode? { channel.platform == "whatsapp" && linked(channel) ? channel.link?.mode : nil }

    static func hasSettings(_ channel: Channel, _ spec: ChannelPlatform?) -> Bool {
        (channel.platform == "telegram" || spec?.settings == true) && linked(channel)
    }

    enum Action: String, Equatable, CaseIterable { case pair, link, settings, mode, replyHeader, fields, unlink, clear }

    /// What a channel's card offers, in the web's order.
    static func actions(_ channel: Channel, _ spec: ChannelPlatform?) -> [Action] {
        var actions: [Action] = []
        let isLinked = linked(channel)
        if channel.login == .qr && !isLinked { actions.append(.pair) }
        if (channel.login == .token || (channel.login == .credentials && spec != nil)) && !isLinked { actions.append(.link) }
        if hasSettings(channel, spec) { actions.append(.settings) }
        let m = mode(channel)
        if m != nil { actions.append(.mode) }
        if m == .selfChat { actions.append(.replyHeader) }
        if !channel.fields.isEmpty { actions.append(.fields) }
        if isLinked { actions.append(.unlink) }
        if channel.link == nil && channel.configured { actions.append(.clear) }
        return actions
    }

    enum UnlinkWords: Equatable { case telegram, credentials, whatsapp }

    static func unlinkWords(_ channel: Channel) -> UnlinkWords {
        if channel.platform == "telegram" { return .telegram }
        return channel.login == .credentials ? .credentials : .whatsapp
    }

    /// The account in one line: its name, then its handle or number.
    static func account(_ link: ChannelLink?) -> String? {
        guard let link, link.linked else { return nil }
        let parts = [link.accountName, link.accountUsername.map { "@\($0)" }, link.accountPhone.map { "+\($0)" }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // The reply header (WhatsApp, «Message yourself»).
    static let replyTitleMax = 64
    static let replyRule = "────────────"

    static func replyCustom(current: String?, agentName: String) -> Bool { current != nil && current != agentName }

    static func replyTitle(custom: Bool, agentName: String, typed: String) -> String {
        (custom ? typed : agentName).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }

    static func replyUsable(_ title: String) -> Bool { !title.isEmpty && title.unicodeScalars.count <= replyTitleMax }

    /// The fields editor's save, split the way the contract asks from what each field declared itself to be.
    static func write(_ fields: [ChannelField], draft: [String: JSONValue]) -> ChannelWrite {
        var credentials: [String: String] = [:]
        var configuration: [String: JSONValue] = [:]
        for field in fields {
            let value = draft[field.key] ?? field.value
            if field.target == .credentials {
                if case .string(let s)? = value { credentials[field.key] = s }
            } else {
                configuration[field.key] = value ?? .null
            }
        }
        return ChannelWrite(credentials: credentials, configuration: configuration)
    }
}

/// A channel's own settings (web ChannelSettingsPanel): gathered, then saved together (one gateway restart).
enum ChannelSettingRules {
    static let sections: [ChannelSetting.Section] = [.access, .replies, .groups, .media, .advanced]

    /// Comma-, space- or Arabic-comma-separated ids, as a person types them.
    static func ids(_ text: String) -> [String] {
        text.components(separatedBy: CharacterSet(charactersIn: ",،").union(.whitespacesAndNewlines)).filter { !$0.isEmpty }
    }

    static func current(_ option: ChannelSetting, _ draft: [String: JSONValue]) -> JSONValue? { draft[option.key] ?? option.value }

    static func effective(_ option: ChannelSetting, _ draft: [String: JSONValue]) -> JSONValue? {
        if let value = current(option, draft), value != .null { return value }
        return option._default
    }

    /// A text, list or number shown in its field.
    static func shown(_ option: ChannelSetting, _ draft: [String: JSONValue]) -> String { JSONCoding.string(current(option, draft)) }

    /// What was typed into a text-like option: empty is back to the default.
    static func typed(_ text: String) -> JSONValue { text.isEmpty ? .null : .string(text) }

    static func numberOk(_ option: ChannelSetting, _ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return true }
        guard let n = Int(t) else { return false }
        return (option.min.map { n >= $0 } ?? true) && (option.max.map { n <= $0 } ?? true)
    }

    /// The draft as the values the hub takes: lists as arrays, numbers as numbers, null for the default.
    static func values(_ options: [ChannelSetting], _ draft: [String: JSONValue]) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for (key, value) in draft {
            let option = options.first { $0.key == key }
            if let option, case .string(let text) = value {
                switch option.kind {
                case .list: out[key] = .array(ids(text).map(JSONValue.string))
                case .number: out[key] = Int(text.trimmingCharacters(in: .whitespaces)).map(JSONValue.int) ?? .null
                default: out[key] = value
                }
            } else {
                out[key] = value
            }
        }
        return out
    }

    /// The keys of numbers out of range.
    static func problems(_ options: [ChannelSetting], _ draft: [String: JSONValue]) -> Set<String> {
        Set(options.filter { option in
            guard option.kind == .number, case .string(let text)? = draft[option.key] else { return false }
            return !numberOk(option, text)
        }.map(\.key))
    }

    enum Default: Equatable { case none, on(Bool), choice(String), text(String) }

    static func `default`(_ option: ChannelSetting) -> Default {
        switch option._default {
        case nil, .null?: return .none
        case .array(let items)? where items.isEmpty: return .none
        case .bool(let on)?: return .on(on)
        case let value?:
            return option.kind == .select ? .choice(JSONCoding.string(value)) : .text(JSONCoding.string(value))
        }
    }
}

/// Hermes's incoming webhooks under the channels (decision §97, web webhooks.ts).
enum WebhookRules {
    enum NameProblem: Equatable { case invalid, taken }

    static func nameProblem(_ typed: String, taken: Set<String>) -> NameProblem? {
        let name = typed.trimmingCharacters(in: .whitespaces).lowercased()
        if name.isEmpty { return nil }
        if name.range(of: "^[a-z0-9][a-z0-9_-]{0,63}$", options: .regularExpression) == nil { return .invalid }
        return taken.contains(name) ? .taken : nil
    }

    static func ready(name: String, prompt: String, taken: Set<String>) -> Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty && nameProblem(name, taken: taken) == nil && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// `issues, push` → `[issues, push]`.
    static func events(_ text: String) -> [String] {
        var seen: [String] = []
        for part in text.components(separatedBy: CharacterSet(charactersIn: ",،").union(.whitespacesAndNewlines)) where !part.isEmpty && !seen.contains(part) {
            seen.append(part)
        }
        return seen
    }

    static func url(hub: String, path: String) -> String {
        var base = hub
        while base.hasSuffix("/") { base.removeLast() }
        return base + path
    }

    /// Where an answer may go: the log, or a channel switched on and set up.
    static func targets(_ channels: [Channel]) -> [Channel] { channels.filter { $0.platform != "webhook" && $0.enabled && $0.configured } }

    static func accepted(_ status: Int) -> Bool { (200..<300).contains(status) }
}
