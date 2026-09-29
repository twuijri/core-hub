// An agent's MCP servers (apps batch 9, the web's page): the hub's own tools card, then every server
// with its switch, what it runs or where it points, Test (Hermes connects once and lists its tools),
// Edit and Delete (after asking), and New server. A server is edited as a form — a command with its
// arguments and variables, or an address with its headers — or as its JSON for anything else; keys the
// form does not show are kept, and a stored credential stays unless it is typed again.
// Android's AgentMcpPage.kt is its twin.
import CoreHubClient
import SwiftUI

/// What a test said: Hermes's tools, or why it could not connect; or the hub's refusal.
struct McpTest {
    var result: McpTestResult?
    var error: String?
}

struct AgentMcpPage: View {
    let agent: Agent
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var tests: [String: McpTest] = [:]
    @State private var testing: Set<String> = []
    @State private var error: String?
    @State private var editing: McpServer?
    @State private var creating = false
    @State private var question: ToolQuestion?
    @State private var hubServer: String?

    var body: some View {
        AsyncContent(key: app.currentProfile) {
            let profile = app.currentProfile
            return try await app.api.call { try await AgentsAPI.agentsListMcpServers(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }.items
        } content: { all, reload in
            let servers = McpRules.listed(all, hubServer: hubServer)
            List {
                NoticeView(text: l10n("agents2.mcp.restart_note"), tone: .info)
                    .listRowBackground(Color.clear)
                HubToolsSection(agent: agent) { hubServer = $0 }
                Section {
                    if let error { NoticeView(text: error, tone: .danger) }
                    if servers.isEmpty {
                        EmptyStateView(icon: .server, title: l10n("agents2.mcp.none"), message: l10n("agents2.mcp.none_body"))
                    }
                    ForEach(servers, id: \.name) { server in
                        McpServerRow(
                            server: server, result: tests[server.name], testing: testing.contains(server.name),
                            switched: { on in
                                Task {
                                    await change(reload) { profile in
                                        _ = try await app.api.call {
                                            try await AgentsAPI.agentsUpdateMcpServer(xHubProfile: profile, agentId: agent.id, serverName: server.name,
                                                                                      mcpServerPatch: McpServerPatch(enabled: on), apiConfiguration: $0)
                                        }
                                    }
                                }
                            },
                            edit: { editing = server },
                            // The hub keeps the answer as the server's last test (§134): read it back.
                            runTest: { Task { await test(server.name); reload() } },
                            delete: {
                                question = ToolQuestion(title: l10n("agents2.mcp.delete_title", ["name": server.name]), body: l10n("agents2.mcp.delete_body"),
                                                        confirm: l10n("kit.delete")) {
                                    Task {
                                        await change(reload) { profile in
                                            try await app.api.call { try await AgentsAPI.agentsDeleteMcpServer(xHubProfile: profile, agentId: agent.id, serverName: server.name, apiConfiguration: $0) }
                                        }
                                        tests[server.name] = nil
                                    }
                                }
                            },
                            oauth: AnyView(McpOAuthRow(agent: agent, server: server, changed: reload))
                        )
                    }
                } header: {
                    HStack {
                        Text(l10n("nav.mcp"))
                        Spacer()
                        Button {
                            creating = true
                        } label: {
                            LucideLabel(l10n("agents2.mcp.new"), icon: .plus, size: 14)
                        }
                        .accessibilityIdentifier("mcp.new")
                    }
                }
            }
            .refreshable { reload() }
            .toolQuestion($question)
            .sheet(isPresented: $creating) {
                McpEditorSheet(server: nil) { name, config, _ in
                    let profile = app.currentProfile
                    _ = try await app.api.call {
                        try await AgentsAPI.agentsCreateMcpServer(xHubProfile: profile, agentId: agent.id,
                                                                  mcpServerWrite: McpServerWrite(name: name, transport: McpRules.transport(config), enabled: true, config: config),
                                                                  apiConfiguration: $0)
                    }
                    reload()
                }
            }
            .sheet(item: Binding(get: { editing.map(McpEditing.init) }, set: { if $0 == nil { editing = nil } })) { item in
                McpEditorSheet(server: item.server) { _, config, transport in
                    let profile = app.currentProfile
                    _ = try await app.api.call {
                        try await AgentsAPI.agentsUpdateMcpServer(xHubProfile: profile, agentId: agent.id, serverName: item.server.name,
                                                                  mcpServerPatch: McpServerPatch(transport: transport, config: config), apiConfiguration: $0)
                    }
                    reload()
                }
            }
        }
    }

    private func change(_ reload: @escaping () -> Void, _ call: @escaping (String) async throws -> Void) async {
        do {
            try await call(app.currentProfile)
            error = nil
        } catch {
            self.error = AgentToolErrors.describe(error, l10n)
        }
        reload()
    }

    private func test(_ name: String) async {
        let profile = app.currentProfile
        testing.insert(name)
        defer { testing.remove(name) }
        do {
            let result = try await app.api.call { try await AgentsAPI.agentsTestMcpServer(xHubProfile: profile, agentId: agent.id, serverName: name, apiConfiguration: $0) }
            tests[name] = McpTest(result: result)
        } catch {
            tests[name] = McpTest(error: AgentToolErrors.describe(error, l10n))
        }
    }
}

private struct McpEditing: Identifiable {
    let server: McpServer
    var id: String { server.name }
}

struct McpServerRow: View {
    let server: McpServer
    let result: McpTest?
    let testing: Bool
    let switched: (Bool) -> Void
    let edit: () -> Void
    let runTest: () -> Void
    let delete: () -> Void
    /// The server's OAuth sign-in in this profile (DECISIONS §122), `McpOAuthRow`.
    var oauth: AnyView? = nil
    @Environment(\.l10n) private var l10n

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            HStack(spacing: Space.s2) {
                Text(server.name).font(.system(size: FontSize.sizeMd, weight: .semibold))
                StatusPill(text: server.transport.rawValue)
                if let count = toolCount { count }
                Spacer()
                StatusPill(text: server.connected ? l10n("mcp.connected") : (server.enabled ? l10n("mcp.not_connected") : l10n("agents2.mcp.off")),
                           kind: server.connected ? .good : .neutral)
                Toggle(server.name, isOn: Binding(get: { server.enabled }, set: switched))
                    .labelsHidden()
                    .accessibilityIdentifier("mcp.\(server.name).switch")
            }
            let summary = McpRules.summary(server)
            if !summary.isEmpty {
                Text(summary).font(.system(size: FontSize.sizeXs, design: .monospaced)).foregroundStyle(Tone.textMuted).lineLimit(2)
                    .environment(\.layoutDirection, .leftToRight)
            }
            if let last = server.lastTest {
                McpLastTestView(server: server, last: last)
            } else {
                Text(l10n("mcp.tools", ["count": String(server.tools.count)])).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
            }
            if let error = server.error { NoticeView(text: error, tone: .danger) }
            // The kept test above says what this one said; a refusal by the hub is still shown here.
            if server.lastTest == nil || result?.error != nil { McpTestView(name: server.name, test: result) }
            if let oauth { oauth }
            HStack {
                Button(action: runTest) {
                    if testing { ProgressView() } else { LucideLabel(l10n("mcp.test"), icon: .activity, size: 14) }
                }
                .buttonStyle(ChipButtonStyle())
                .disabled(testing)
                .accessibilityIdentifier("mcp.\(server.name).test")
                Spacer()
                Menu {
                    Button(action: edit) { LucideLabel(l10n("agents2.mcp.edit"), icon: .pencil) }
                    Button(role: .destructive, action: delete) { LucideLabel(l10n("kit.delete"), icon: .trash) }
                } label: {
                    LucideIcon(.ellipsis, size: 16).foregroundStyle(Tone.textMuted).frame(width: 32, height: 32)
                }
                .accessibilityIdentifier("mcp.\(server.name).more")
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive, action: delete) { LucideLabel(l10n("kit.delete"), icon: .trash) }
            Button(action: edit) { LucideLabel(l10n("agents2.mcp.edit"), icon: .pencil) }
        }
        .accessibilityIdentifier("mcp.\(server.name)")
    }
}

extension McpServerRow {
    /// "61 tools", "12 of 61 tools", or that the last test failed — from the kept test (§134).
    fileprivate var toolCount: StatusPill? {
        guard let last = server.lastTest else { return nil }
        guard last.ok else { return StatusPill(text: l10n("agents2.mcp.test_failed_short"), kind: .bad) }
        let count = McpRules.toolCount(last.tools.map(\.name), include: server.toolFilter?.include, exclude: server.toolFilter?.exclude)
        let text = count.filtered
            ? l10n("agents2.mcp.tool_count_filtered", ["allowed": String(count.allowed), "total": String(count.total)])
            : l10n("agents2.mcp.tool_count", ["count": String(count.total)])
        return StatusPill(text: text, kind: last.stale ? .warn : .neutral)
    }
}

/// The last test the hub kept for a server in this profile (DECISIONS §134): its tools without testing
/// again, each with how the hub reads it and whether the agent may use it. Choosing them is on the web.
struct McpLastTestView: View {
    let server: McpServer
    let last: McpLastTest
    @Environment(\.l10n) private var l10n

    private func access(_ tool: McpTestedTool) -> String {
        if tool.access == .read { return l10n("agents2.mcp.access_read") }
        if tool.access == .write { return l10n("agents2.mcp.access_write") }
        return l10n("agents2.mcp.access_unknown")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            if last.stale { NoticeView(text: l10n("agents2.mcp.tools_stale"), tone: .warning) }
            if last.ok {
                NoticeView(text: l10n("agents2.mcp.test_ok", ["count": String(last.tools.count), "seconds": McpRules.seconds(last.durationMs)])
                    + (last.tools.isEmpty ? " " + l10n("agents2.mcp.no_tools") : ""), tone: .success)
                ForEach(last.tools, id: \.name) { tool in
                    let on = McpRules.allowed(tool.name, include: server.toolFilter?.include, exclude: server.toolFilter?.exclude)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: Space.s1) {
                            Text(verbatim: tool.name)
                                .font(.system(size: FontSize.sizeXs, design: .monospaced))
                                .foregroundStyle(on ? Tone.text : Tone.textMuted)
                            StatusPill(text: access(tool), kind: tool.access == .read ? .good : (tool.access == .write ? .warn : .neutral))
                            if !on { StatusPill(text: l10n("agents2.mcp.tool_off")) }
                        }
                        if let description = tool.description, !description.isEmpty {
                            Text(description).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted).contentDirection(of: description)
                        }
                    }
                    .accessibilityIdentifier("mcp.\(server.name).tool.\(tool.name)")
                }
                if !last.tools.isEmpty {
                    Text(l10n("agents2.mcp.tools_pick_on_web")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                }
            } else {
                NoticeView(text: l10n("agents2.mcp.test_failed") + " " + (last.error ?? ""), tone: .danger)
            }
        }
        .accessibilityIdentifier("mcp.\(server.name).last")
    }
}

/// Hermes's answer to a test: the tools it listed (with how long it took), or why it could not connect.
struct McpTestView: View {
    let name: String
    let test: McpTest?
    @Environment(\.l10n) private var l10n

    var body: some View {
        if let error = test?.error {
            NoticeView(text: error, tone: .danger).accessibilityIdentifier("mcp.\(name).result")
        } else if let result = test?.result {
            if result.ok {
                VStack(alignment: .leading, spacing: Space.s1) {
                    NoticeView(text: l10n("agents2.mcp.test_ok", ["count": String(result.tools.count), "seconds": McpRules.seconds(result.durationMs)])
                        + (result.tools.isEmpty ? " " + l10n("agents2.mcp.no_tools") : ""), tone: .success)
                    FlowLayout(spacing: Space.s1) {
                        ForEach(result.tools, id: \.name) { tool in StatusPill(text: tool.name) }
                    }
                    .environment(\.layoutDirection, .leftToRight)
                }
                .accessibilityIdentifier("mcp.\(name).result")
            } else {
                NoticeView(text: l10n("agents2.mcp.test_failed") + " " + (result.error ?? ""), tone: .danger).accessibilityIdentifier("mcp.\(name).result")
            }
        }
    }
}

/// New server or Edit: the name (new only), a form for a command or an address, or the server's JSON.
struct McpEditorSheet: View {
    let server: McpServer?
    let save: (String, [String: JSONValue], McpServerPatch.Transport?) async throws -> Void
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var draft: McpRules.Draft
    @State private var json: String?
    @State private var tried = false
    @State private var saving = false
    @State private var failure: String?

    init(server: McpServer?, save: @escaping (String, [String: JSONValue], McpServerPatch.Transport?) async throws -> Void) {
        self.server = server
        self.save = save
        _name = State(initialValue: server?.name ?? "")
        _draft = State(initialValue: server.map { McpRules.draft($0.config) } ?? McpRules.template)
    }

    private var parsed: [String: JSONValue]? { json.flatMap(McpRules.parse) }
    private var config: [String: JSONValue]? { json != nil ? parsed : McpRules.config(draft) }
    private var problem: McpRules.Problem? { json == nil ? McpRules.problem(draft) : nil }
    private var badName: Bool { !name.isEmpty && !McpRules.validName(name) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(l10n("agents2.mcp.editor_note")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                    if let failure { NoticeView(text: failure, tone: .danger) }
                    if server == nil {
                        TextField(l10n("agents2.mcp.name"), text: $name, prompt: Text(verbatim: "filesystem"))
                            .monoField()
                            .accessibilityIdentifier("mcp.editor.name")
                        if badName { problemText(l10n("agents2.mcp.name_bad")) }
                    }
                }
                if json == nil {
                    Section(l10n("agents2.mcp.kind")) {
                        Picker(l10n("agents2.mcp.kind"), selection: $draft.kind) {
                            Text(l10n("agents2.mcp.kind_command")).tag(McpRules.Kind.command)
                            Text(l10n("agents2.mcp.kind_url")).tag(McpRules.Kind.url)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("mcp.editor.kind")
                        if draft.kind == .command {
                            TextField(l10n("agents2.mcp.command"), text: $draft.command).monoField().accessibilityIdentifier("mcp.editor.command")
                            if tried && problem == .commandRequired { problemText(l10n("agents2.mcp.command_required")) }
                            hint(l10n("agents2.mcp.command_hint"))
                            TextField(l10n("agents2.mcp.args"), text: $draft.args, axis: .vertical).lineLimit(3...10).monoField().accessibilityIdentifier("mcp.editor.args")
                            hint(l10n("agents2.mcp.args_hint"))
                        } else {
                            TextField(l10n("agents2.mcp.url"), text: $draft.url, prompt: Text(verbatim: "https://")).monoField().keyboardType(.URL)
                                .accessibilityIdentifier("mcp.editor.url")
                            if tried && problem == .urlBad { problemText(l10n("agents2.mcp.url_bad")) }
                            hint(l10n("agents2.mcp.url_hint"))
                        }
                    }
                    Section {
                        if draft.kind == .command {
                            KeyValueRows(rows: $draft.env, tag: "env")
                        } else {
                            KeyValueRows(rows: $draft.headers, tag: "headers")
                        }
                        if tried && problem == .rowBad { problemText(l10n("agents2.mcp.row_bad")) }
                    } header: {
                        Text(l10n(draft.kind == .command ? "agents2.mcp.env" : "agents2.mcp.headers"))
                    } footer: {
                        if !draft.rest.isEmpty { Text(l10n("agents2.mcp.kept", ["keys": draft.rest.keys.sorted().joined(separator: ", ")])) }
                    }
                } else {
                    Section {
                        TextEditor(text: Binding(get: { json ?? "" }, set: { json = $0 }))
                            .font(.system(size: FontSize.sizeSm, design: .monospaced))
                            .frame(minHeight: 260)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .environment(\.layoutDirection, .leftToRight)
                            .accessibilityIdentifier("mcp.editor.json")
                        if parsed == nil { NoticeView(text: l10n("agents2.mcp.invalid_json"), tone: .warning) }
                    }
                }
                Section {
                    Button {
                        if json == nil {
                            json = McpRules.json(McpRules.config(draft))
                        } else if let parsed {
                            draft = McpRules.draft(parsed)
                            json = nil
                        }
                    } label: {
                        LucideLabel(l10n(json == nil ? "agents2.mcp.as_json" : "agents2.mcp.as_form"), icon: .fileCog, size: 14)
                    }
                    .disabled(json != nil && parsed == nil)
                    .accessibilityIdentifier("mcp.editor.mode")
                }
            }
            .navigationTitle(server?.name ?? l10n("agents2.mcp.new"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(l10n("common.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button(l10n("common.save")) { Task { await submit() } }
                            .disabled(name.isEmpty || badName || config == nil)
                            .accessibilityIdentifier("mcp.editor.save")
                    }
                }
            }
        }
    }

    private func hint(_ text: String) -> some View { Text(text).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted) }
    private func problemText(_ text: String) -> some View { Text(text).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.danger) }

    private func submit() async {
        tried = true
        guard let config, problem == nil, McpRules.validName(name) else { return }
        saving = true
        defer { saving = false }
        do {
            try await save(name.trimmingCharacters(in: .whitespaces), config, server.flatMap { McpRules.transportChange($0, config) })
            dismiss()
        } catch {
            failure = HubFailure(error).describe(l10n)
        }
    }
}

/// Variables or headers: a name and a secret value per row (a stored one stays unless typed again).
private struct KeyValueRows: View {
    @Binding var rows: [McpRules.Row]
    let tag: String
    @Environment(\.l10n) private var l10n

    var body: some View {
        ForEach($rows) { $row in
            HStack(spacing: Space.s2) {
                TextField(l10n("agents2.mcp.row_name"), text: $row.key).monoField().frame(maxWidth: 130)
                SecretValueField(placeholder: row.stored ? l10n("agents2.mcp.stored") : l10n("agents2.mcp.row_value"), text: $row.value)
                Button {
                    let id = row.id
                    rows.removeAll { $0.id == id }
                } label: {
                    LucideIcon(.x, size: 14).foregroundStyle(Tone.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(l10n("agents2.mcp.row_remove"))
            }
        }
        Button {
            rows.append(McpRules.Row())
        } label: {
            LucideLabel(l10n("agents2.mcp.row_add"), icon: .plus, size: 14)
        }
        .accessibilityIdentifier("mcp.editor.\(tag).add")
    }
}

/// A value typed hidden, with an eye to show it.
struct SecretValueField: View {
    let placeholder: String
    @Binding var text: String
    @State private var shown = false
    @Environment(\.l10n) private var l10n

    var body: some View {
        HStack(spacing: Space.s1) {
            Group {
                if shown { TextField(placeholder, text: $text) } else { SecureField(placeholder, text: $text) }
            }
            .monoField()
            Button {
                shown.toggle()
            } label: {
                LucideIcon(shown ? .eyeOff : .eye, size: 14).foregroundStyle(Tone.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(l10n(shown ? "kit.hide_secret" : "kit.show_secret"))
        }
    }
}

extension View {
    /// A field for a name, a command or a key: monospaced, left to right, never corrected.
    func monoField() -> some View {
        font(.system(size: FontSize.sizeSm, design: .monospaced))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .environment(\.layoutDirection, .leftToRight)
    }
}

/// «Core Hub tools» (decision §67): the hub offers itself to this agent as an MCP server, in groups. Off
/// until an admin switches it on; each group reads, and changes only when its second switch says so.
/// A hub or an agent without it (not Hermes) answers otherwise: the section then shows nothing.
struct HubToolsSection: View {
    let agent: Agent
    let found: (String) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var data: HubTools?
    @State private var busy = false
    @State private var error: String?
    @State private var result: McpTest?
    @State private var testing = false

    var body: some View {
        Group {
            if let data {
                Section {
                    Toggle(isOn: Binding(get: { data.enabled }, set: { on in Task { await change(HubToolsPatch(enabled: on)) } })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(l10n("agents2.hub.enabled"))
                            Text(l10n("agents2.hub.subtitle")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                        }
                    }
                    .disabled(busy || (!data.available && !data.enabled))
                    .accessibilityIdentifier("hub.tools.switch")
                    if !data.available {
                        NoticeView(text: l10n("agents2.hub.unavailable.\((data.unavailableReason ?? .runtimeAbsent).rawValue)"), tone: .warning)
                    }
                    Text(l10n("agents2.hub.acts_as")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                    if let error { NoticeView(text: error, tone: .danger) }
                    ForEach(data.groups, id: \.id) { group in groupRow(group, disabled: !data.enabled || busy) }
                    HStack {
                        Button {
                            Task {
                                testing = true
                                await runTest(data.serverName)
                                testing = false
                            }
                        } label: {
                            if testing { ProgressView() } else { LucideLabel(l10n("mcp.test"), icon: .activity, size: 14) }
                        }
                        .buttonStyle(ChipButtonStyle())
                        .disabled(!data.enabled || testing)
                        .accessibilityIdentifier("hub.tools.test")
                        if let url = data.url {
                            Text(url).font(.system(size: FontSize.sizeXs, design: .monospaced)).foregroundStyle(Tone.textMuted).lineLimit(1)
                        }
                    }
                    McpTestView(name: data.serverName, test: result)
                    recent(data.recentCalls)
                } header: {
                    Text(l10n("agents2.hub.title"))
                }
            }
        }
        .task(id: app.currentProfile) { await load() }
    }

    @ViewBuilder
    private func groupRow(_ group: HubToolGroup, disabled: Bool) -> some View {
        let writes = group.tools.contains { $0.access == .write }
        let reads = group.tools.contains { $0.access == .read }
        VStack(alignment: .leading, spacing: Space.s1) {
            Toggle(isOn: Binding(get: { group.enabled }, set: { on in
                Task { await change(HubToolsPatch(groups: [HubToolsPatchGroupsInner(id: group.id, enabled: on)])) }
            })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(l10n("agents2.hub.group.\(group.id.rawValue)")).font(.system(size: FontSize.sizeMd, weight: .medium))
                    Text(l10n("agents2.hub.group_about.\(group.id.rawValue)")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                }
            }
            .disabled(disabled)
            .accessibilityIdentifier("hub.group.\(group.id.rawValue).switch")
            FlowLayout(spacing: Space.s1) {
                ForEach(group.tools, id: \.name) { tool in StatusPill(text: tool.name, kind: tool.access == .write ? .warn : .neutral) }
            }
            .environment(\.layoutDirection, .leftToRight)
            if !reads { Text(l10n("agents2.hub.writes_only")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted) }
            if writes {
                Toggle(l10n("agents2.hub.allow_writes"), isOn: Binding(get: { group.allowWrites }, set: { on in
                    Task { await change(HubToolsPatch(groups: [HubToolsPatchGroupsInner(id: group.id, allowWrites: on)])) }
                }))
                .font(.system(size: FontSize.sizeSm))
                .disabled(disabled || !group.enabled)
                .accessibilityIdentifier("hub.group.\(group.id.rawValue).writes")
            }
        }
    }

    @ViewBuilder
    private func recent(_ calls: [HubToolCall]) -> some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            Text(l10n("agents2.hub.recent")).font(.system(size: FontSize.sizeSm, weight: .medium))
            if calls.isEmpty { Text(l10n("agents2.hub.no_calls")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted) }
            ForEach(calls, id: \.id) { call in
                HStack(spacing: Space.s1) {
                    StatusPill(text: l10n(call.ok ? "agents2.hub.call_ok" : "agents2.hub.call_failed"), kind: call.ok ? .good : .bad)
                    Text(call.tool).font(.system(size: FontSize.sizeXs, design: .monospaced))
                    if let code = call.errorCode {
                        Text(reason(code)).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted).lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    Text(call.createdAt.shortText(app.language)).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textFaint)
                }
                .accessibilityIdentifier("hub.tools.call")
            }
        }
    }

    /// The hub's own reasons read as sentences; any other code as itself.
    private func reason(_ code: String) -> String {
        let key = "agents2.hub.reason.\(code)"
        let said = l10n(key)
        return said == key ? code : said
    }

    private func load() async {
        let profile = app.currentProfile
        if let tools = try? await app.api.call({ try await AgentsAPI.agentsGetHubTools(xHubProfile: profile, agentId: agent.id, apiConfiguration: $0) }) {
            data = tools
            found(tools.serverName)
        }
    }

    private func change(_ patch: HubToolsPatch) async {
        let profile = app.currentProfile
        busy = true
        defer { busy = false }
        do {
            data = try await app.api.call { try await AgentsAPI.agentsUpdateHubTools(xHubProfile: profile, agentId: agent.id, hubToolsPatch: patch, apiConfiguration: $0) }
            error = nil
        } catch {
            self.error = AgentToolErrors.describe(error, l10n)
        }
    }

    private func runTest(_ name: String) async {
        let profile = app.currentProfile
        do {
            let r = try await app.api.call { try await AgentsAPI.agentsTestMcpServer(xHubProfile: profile, agentId: agent.id, serverName: name, apiConfiguration: $0) }
            result = McpTest(result: r)
        } catch {
            result = McpTest(error: AgentToolErrors.describe(error, l10n))
        }
    }
}

extension PhonePage {
    static let agentMcp = PhonePage(.agentMcp) { context in
        if let agent = context.agent { AgentMcpPage(agent: agent) }
    }
}
