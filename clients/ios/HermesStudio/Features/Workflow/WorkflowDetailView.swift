import SwiftUI

/// One workflow: live status, run and stop, the run history, the schedules
/// and the read-only graph summary.
struct WorkflowDetailView: View {
    @EnvironmentObject private var store: AppStore
    @StateObject private var live = WorkflowLiveStatuses()
    let workflow: WorkflowItem

    @State private var detail: WorkflowItem?
    @State private var runs: [WorkflowRun] = []
    @State private var loading = true
    @State private var showingRun = false
    @State private var exportURL: URL?

    private var current: WorkflowItem { detail ?? workflow }
    private var status: WorkflowRuntimeStatus? { live.status(for: workflow.id) }

    var body: some View {
        List {
            overviewSection
            runsSection
            linksSection
        }
        .listStyle(.insetGrouped)
        .navigationTitle(current.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let exportURL { ShareLink(item: exportURL) { Image(systemName: "square.and.arrow.up") } }
                else { Button { Task { await export() } } label: { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Export workflow") }
            }
        }
        .refreshable { await load() }
        .task(id: workflow.id) {
            await load()
            live.start(baseURL: store.baseURL, token: store.token, profile: current.profile.nilIfEmpty ?? store.selectedProfile, workflowID: workflow.id)
        }
        .onDisappear { live.stop() }
        .onChange(of: status?.status) { _, _ in Task { await loadRuns() } }
        .sheet(isPresented: $showingRun) { WorkflowRunPromptView(workflow: current) { await loadRuns() } }
    }

    private var overviewSection: some View {
        Section {
            LabeledContent("Status") { WorkflowStatusChip(status: status?.status ?? "idle") }
            LabeledContent("Profile") { TechnicalText(text: current.profile) }
            LabeledContent("Nodes") { Text(verbatim: "\(current.nodeCount)").environment(\.layoutDirection, .leftToRight) }
            if !current.workspace.isEmpty { LabeledContent("Workspace") { TechnicalText(text: current.workspace) } }
            if let message = status?.error.nilIfEmpty {
                Text(message).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.error)
            }
            Button { showingRun = true } label: { Label("Run workflow", systemImage: "play.fill") }
                .disabled(status?.isActive == true)
            if let status, status.isActive, !status.runID.isEmpty {
                Button(role: .destructive) { Task { await stop(runID: status.runID) } } label: { Label("Stop run", systemImage: "stop.fill") }
            }
        }
    }

    private var runsSection: some View {
        Section("Run history") {
            if loading && runs.isEmpty { ProgressView() }
            if !loading && runs.isEmpty { Text("No runs yet").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted) }
            ForEach(runs) { run in
                NavigationLink { WorkflowRunView(workflow: current, runID: run.id, live: live) } label: { runRow(run) }
                    .swipeActions {
                        Button(role: .destructive) { Task { await deleteRun(run) } } label: { Label("Delete", systemImage: "trash") }
                    }
            }
        }
    }

    private func runRow(_ run: WorkflowRun) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                TechnicalText(text: String(run.id.prefix(12)), font: CoreHubTokens.Typography.sessionTitleFont, color: CoreHubTokens.Palette.textPrimary)
                HStack(spacing: 6) {
                    Text("\(run.nodes.count) nodes")
                    Text(SessionTimeFormatter.string(for: run.createdAt > 0 ? Date(timeIntervalSince1970: Double(run.createdAt) / 1000) : nil, locale: store.locale))
                }
                .font(CoreHubTokens.Typography.metaFont)
                .foregroundStyle(CoreHubTokens.Palette.textMuted)
            }
            Spacer(minLength: 0)
            WorkflowStatusChip(status: run.status)
        }
    }

    private var linksSection: some View {
        Section {
            NavigationLink { WorkflowSchedulesView(workflow: current) } label: { Label("Schedules", systemImage: "calendar.badge.clock") }
            NavigationLink { WorkflowGraphView(workflow: current) } label: { Label("Graph summary", systemImage: "point.3.connected.trianglepath.dotted") }
        }
    }

    // MARK: Data

    private func load() async {
        loading = true
        detail = (await store.attempt { try await store.api.workflow(workflow.id) }) ?? detail
        await loadRuns()
        loading = false
    }

    private func loadRuns() async {
        runs = (await store.attempt { try await store.api.workflowRuns(workflow.id) }) ?? runs
    }

    private func stop(runID: String) async {
        guard await store.attempt({ try await store.api.stopWorkflow(workflow.id, runID: runID) }) != nil else { return }
        store.notify(String(localized: "Stopping the run…"))
        await loadRuns()
    }

    private func deleteRun(_ run: WorkflowRun) async {
        guard await store.attempt({ try await store.api.deleteWorkflowRun(workflow.id, runID: run.id) }) != nil else { return }
        runs.removeAll { $0.id == run.id }
    }

    private func export() async {
        guard let data = await store.attempt({ try await store.api.exportWorkflow(workflow.id) }) else { return }
        let name = current.name.replacingOccurrences(of: "/", with: "-")
        exportURL = await store.attempt { try APIClient.writeTemporaryFile(data, name: "\(name)-workflow.json") }
    }
}

/// "Run workflow": optional input, the start nodes to begin from and an
/// optional timeout (`POST /workflows/{id}/run`).
struct WorkflowRunPromptView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let workflow: WorkflowItem
    let reload: () async -> Void

    @State private var input = ""
    @State private var selected: Set<String> = []
    @State private var timeoutMinutes = 0
    @State private var starting = false

    private var nodes: [WorkflowNodeSummary] {
        WorkflowGraph.ordered(nodes: WorkflowGraph.nodes(workflow), edges: WorkflowGraph.edges(workflow))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Optional input", text: $input, axis: .vertical).lineLimit(2...6)
                } header: { Text("Input") } footer: { Text("The input is handed to the start nodes of the run.") }
                Section {
                    if nodes.isEmpty { Text("This workflow has no nodes yet.").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted) }
                    ForEach(nodes) { node in
                        Button { toggle(node.id) } label: {
                            HStack {
                                DirectionalText(text: node.title, font: CoreHubTokens.Typography.sessionTitleFont)
                                Spacer(minLength: 0)
                                if selected.contains(node.id) { CoreHubIconView(icon: .check, size: 14).foregroundStyle(CoreHubTokens.Palette.success) }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                } header: { Text("Start nodes") } footer: { Text("Leave empty to start where the workflow normally starts.") }
                Section("Timeout") {
                    Stepper(timeoutMinutes == 0 ? String(localized: "Server default") : String(localized: "\(timeoutMinutes) minutes"), value: $timeoutMinutes, in: 0...240, step: 5)
                }
            }
            .navigationTitle("Run workflow")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Run") { Task { await start() } }.disabled(starting) }
            }
        }
    }

    private func toggle(_ id: String) {
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
    }

    private func start() async {
        starting = true
        defer { starting = false }
        let timeout = timeoutMinutes > 0 ? timeoutMinutes * 60_000 : nil
        guard await store.attempt({
            try await store.api.runWorkflow(workflow.id, input: input.nilIfEmpty, startNodeIDs: Array(selected), timeoutMs: timeout)
        }) != nil else { return }
        store.notify(String(localized: "Workflow started"))
        await reload()
        dismiss()
    }
}
