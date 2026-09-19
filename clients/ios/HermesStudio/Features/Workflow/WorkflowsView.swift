import SwiftUI
import UniformTypeIdentifiers

/// Status chip shared by the workflow list, the run list and the node
/// timeline (web `WorkflowRuntimeState`).
struct WorkflowStatusChip: View {
    let status: String

    private var color: Color {
        switch WorkflowStatusStyle.tone(for: status) {
        case .neutral: return CoreHubTokens.Palette.textMuted
        case .info: return CoreHubTokens.Palette.info
        case .success: return CoreHubTokens.Palette.success
        case .warning: return CoreHubTokens.Palette.warning
        case .error: return CoreHubTokens.Palette.error
        }
    }

    var body: some View { StatusPill(text: WorkflowStatusStyle.label(for: status), color: color) }
}

/// Workflow list with live status chips from the `/workflow` socket,
/// creation, import (preview → confirm → cancel) and delete.
struct WorkflowsView: View {
    @EnvironmentObject private var store: AppStore
    @StateObject private var live = WorkflowLiveStatuses()
    @State private var workflows: [WorkflowItem] = []
    @State private var loading = true
    @State private var creating = false
    @State private var importing = false
    @State private var importSummary = ""
    @State private var importToken = ""
    @State private var showingImport = false

    var body: some View {
        List {
            if loading && workflows.isEmpty { ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear) }
            if !loading && workflows.isEmpty {
                EmptyState(icon: "point.3.connected.trianglepath.dotted", title: "No workflows", detail: "Design workflows in Core Hub on the desktop, then run and follow them here.")
                    .listRowBackground(Color.clear)
            }
            ForEach(workflows) { workflow in
                Button { store.open(workflow) } label: { row(workflow) }
                    .buttonStyle(.plain)
                    .listRowBackground(store.selectedWorkflow?.id == workflow.id ? CoreHubTokens.Palette.selected : Color.clear)
                    .swipeActions {
                        Button(role: .destructive) { Task { await delete(workflow) } } label: { Label("Delete", systemImage: "trash") }
                    }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .navigationTitle("Workflow")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { importing = true } label: { Image(systemName: "square.and.arrow.down") }.accessibilityLabel("Import workflow")
                Button { creating = true } label: { CoreHubIconView(icon: .plus, size: 20) }.accessibilityLabel("New workflow")
            }
        }
        .refreshable { await load() }
        .task(id: store.selectedProfile) { await load(); startLive() }
        .onDisappear { live.stop() }
        .sheet(isPresented: $creating) { NewWorkflowView { await load() } }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json, .plainText]) { result in
            if case let .success(url) = result { Task { await previewImport(url) } }
        }
        .alert("Import workflow?", isPresented: $showingImport) {
            Button("Import") { Task { await confirmImport() } }
            Button("Cancel", role: .cancel) { Task { await cancelImport() } }
        } message: { Text(importSummary) }
    }

    private func row(_ workflow: WorkflowItem) -> some View {
        HStack(spacing: 10) {
            CoreHubIconView(icon: .workflow, size: 18).foregroundStyle(CoreHubTokens.Palette.textSecondary)
            VStack(alignment: .leading, spacing: 3) {
                DirectionalText(text: workflow.name, font: CoreHubTokens.Typography.sessionTitleFont)
                HStack(spacing: 8) {
                    Text("\(workflow.nodeCount) nodes")
                    TechnicalText(text: workflow.profile)
                }
                .font(CoreHubTokens.Typography.metaFont)
                .foregroundStyle(CoreHubTokens.Palette.textMuted)
            }
            Spacer(minLength: 0)
            WorkflowStatusChip(status: live.status(for: workflow.id)?.status ?? "idle")
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    private func startLive() {
        live.start(baseURL: store.baseURL, token: store.token, profile: store.selectedProfile)
    }

    private func load() async {
        loading = true
        workflows = (await store.attempt({ try await store.api.workflows(profile: store.selectedProfile) })) ?? workflows
        loading = false
    }

    private func delete(_ workflow: WorkflowItem) async {
        guard await store.attempt({ try await store.api.deleteWorkflow(workflow.id) }) != nil else { return }
        workflows.removeAll { $0.id == workflow.id }
        if store.selectedWorkflow?.id == workflow.id { store.selectedWorkflow = nil }
    }

    private func previewImport(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let document = try String(contentsOf: url, encoding: .utf8)
            let preview = try await store.api.previewWorkflowImport(document, profile: store.selectedProfile)
            let summary = preview.object("summary")
            importToken = preview.string("token")
            importSummary = "\(summary.string("name")) · \(summary.int("nodes")) nodes"
            showingImport = !importToken.isEmpty
        } catch {
            store.errorMessage = error.localizedDescription
        }
    }

    private func confirmImport() async {
        guard await store.attempt({ try await store.api.confirmWorkflowImport(token: importToken, profile: store.selectedProfile) }) != nil else { return }
        importToken = ""
        await load()
    }

    private func cancelImport() async {
        await store.attempt({ try await store.api.cancelWorkflowImport(token: importToken, profile: store.selectedProfile) })
        importToken = ""
    }
}

/// Creates an empty workflow; the graph itself is designed on the desktop.
struct NewWorkflowView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let reload: () async -> Void
    @State private var name = ""
    @State private var profile = ""
    @State private var workspace = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name).contentDirection(of: name)
                    Picker("Profile", selection: $profile) { ForEach(store.profiles) { Text($0.name).tag($0.name) } }
                    TextField("Workspace path", text: $workspace).textInputAutocapitalization(.never).autocorrectionDisabled()
                } footer: {
                    Text("The app creates the workflow and runs it; nodes and edges are designed in the Core Hub web or desktop client.")
                }
            }
            .navigationTitle("New workflow")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await save() } }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || saving)
                }
            }
            .onAppear { if profile.isEmpty { profile = store.selectedProfile } }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        guard await store.attempt({
            try await store.api.saveWorkflow(id: nil, name: name, profile: profile, workspace: workspace.nilIfEmpty, nodes: [], edges: [])
        }) != nil else { return }
        await reload()
        dismiss()
    }
}
