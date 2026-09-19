import SwiftUI

/// One run: the node timeline built from the persisted node sessions merged
/// with the live `nodeStatuses`, inline approvals for blocked nodes, the
/// node output, rerun-from-node and stop.
struct WorkflowRunView: View {
    @EnvironmentObject private var store: AppStore
    let workflow: WorkflowItem
    let runID: String
    @ObservedObject var live: WorkflowLiveStatuses

    @State private var run: WorkflowRun?
    @State private var loading = true
    @State private var busyNode = ""

    private var status: WorkflowRuntimeStatus? {
        guard let value = live.status(for: workflow.id), value.runID == runID else { return nil }
        return value
    }

    private var rows: [WorkflowGraph.TimelineRow] {
        WorkflowGraph.timeline(workflow: workflow, run: run, live: status)
    }

    var body: some View {
        List {
            summarySection
            Section("Nodes") {
                if loading && run == nil { ProgressView() }
                ForEach(rows) { row in
                    WorkflowNodeRow(row: row, busy: busyNode == row.id, approve: { approved in Task { await approve(row, approved: approved) } }, rerun: { Task { await rerun(row) } })
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(Text(verbatim: String(runID.prefix(12))))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: runID) { await load() }
        .onChange(of: status?.status) { _, _ in Task { await load() } }
    }

    private var summarySection: some View {
        Section {
            LabeledContent("Status") { WorkflowStatusChip(status: status?.status ?? run?.status ?? "idle") }
            if let run, !run.triggerSource.isEmpty { LabeledContent("Trigger") { Text(run.triggerSource) } }
            if let message = run?.error.nilIfEmpty ?? status?.error.nilIfEmpty {
                Text(message).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.error)
            }
            if let run, run.isActive {
                Button(role: .destructive) { Task { await stop() } } label: { Label("Stop run", systemImage: "stop.fill") }
            }
        }
    }

    // MARK: Actions

    private func load() async {
        loading = true
        run = (await store.attempt({ try await store.api.workflowRun(workflow.id, runID: runID) })) ?? run
        loading = false
    }

    private func stop() async {
        guard await store.attempt({ try await store.api.stopWorkflow(workflow.id, runID: runID) }) != nil else { return }
        await load()
    }

    private func approve(_ row: WorkflowGraph.TimelineRow, approved: Bool) async {
        busyNode = row.id
        defer { busyNode = "" }
        let node = WorkflowRunNode(["node_id": row.node.id, "execution_id": row.executionID, "status": row.status])
        guard await store.attempt({ try await store.api.approveWorkflowNode(workflow.id, runID: runID, node: node, approved: approved) }) != nil else { return }
        await load()
    }

    private func rerun(_ row: WorkflowGraph.TimelineRow) async {
        busyNode = row.id
        defer { busyNode = "" }
        guard await store.attempt({ try await store.api.rerunWorkflow(workflow.id, runID: runID, nodeID: row.node.id) }) != nil else { return }
        store.notify(String(localized: "Rerunning from this node"))
        await load()
    }
}

/// One timeline row: title, agent, status, duration, the error, an inline
/// approval when the node is blocked, the node output and rerun-from-node.
struct WorkflowNodeRow: View {
    @EnvironmentObject private var store: AppStore
    let row: WorkflowGraph.TimelineRow
    let busy: Bool
    let approve: (Bool) -> Void
    let rerun: () -> Void

    @State private var expanded = false
    @State private var output = ""
    @State private var loadingOutput = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if !row.node.model.isEmpty || !row.node.agent.isEmpty {
                TechnicalText(text: [row.node.agent, row.node.model].filter { !$0.isEmpty }.joined(separator: " · "))
            }
            if !row.error.isEmpty {
                Text(row.error).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.error)
            }
            if row.awaitingApproval { approvalRow }
            if expanded { outputBlock }
            actions
        }
        .padding(.vertical, 4)
    }

    private var header: some View {
        HStack(spacing: 8) {
            DirectionalText(text: row.node.title, font: CoreHubTokens.Typography.font(CoreHubTokens.Typography.sessionTitle, weight: .medium))
            Spacer(minLength: 0)
            if let duration = durationText { Text(duration).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted) }
            WorkflowStatusChip(status: row.status)
        }
    }

    private var durationText: String? {
        guard let started = row.startedAt, let finished = row.finishedAt, finished >= started else { return nil }
        return ThinkingFormat.duration(Double(finished - started) / 1000)
    }

    private var approvalRow: some View {
        HStack(spacing: 8) {
            Button { approve(true) } label: { Text("Approve") }.buttonStyle(CoreHubPillButtonStyle(prominent: true))
            Button { approve(false) } label: { Text("Reject") }.buttonStyle(CoreHubPillButtonStyle())
            if busy { ProgressView().controlSize(.small) }
        }
    }

    private var outputBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            if loadingOutput { ProgressView().controlSize(.small) }
            if output.isEmpty && !loadingOutput {
                Text("This node produced no output.").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted)
            } else {
                MarkdownText(text: output).font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.sidebarTab))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(CoreHubTokens.Palette.bgSecondary, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.button))
    }

    private var actions: some View {
        HStack(spacing: 10) {
            if !row.sessionID.isEmpty {
                Button { toggleOutput() } label: {
                    Group {
                        if expanded { Label("Hide output", systemImage: "chevron.up") }
                        else { Label("Show output", systemImage: "chevron.down") }
                    }
                    .font(CoreHubTokens.Typography.metaFont)
                }
                .buttonStyle(.plain)
                .foregroundStyle(CoreHubTokens.Palette.textSecondary)
            }
            Spacer(minLength: 0)
            Button { rerun() } label: { Text("Rerun from here").font(CoreHubTokens.Typography.metaFont) }
                .buttonStyle(.plain)
                .foregroundStyle(CoreHubTokens.Palette.accent)
                .disabled(busy)
        }
    }

    private func toggleOutput() {
        expanded.toggle()
        guard expanded, output.isEmpty, !row.sessionID.isEmpty else { return }
        Task { await loadOutput() }
    }

    private func loadOutput() async {
        loadingOutput = true
        defer { loadingOutput = false }
        guard let history = await store.attempt({ try await store.api.conversationHistory(sessionID: row.sessionID) }) else { return }
        output = history.messages.last { $0.role != "user" && !$0.content.isEmpty }?.content ?? ""
    }
}
