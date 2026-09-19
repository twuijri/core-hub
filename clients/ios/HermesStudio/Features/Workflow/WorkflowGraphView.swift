import SwiftUI

/// Read-only summary of a workflow graph: the nodes in execution order with
/// their agent, model, skills and approval flag, and the edges that leave
/// each node. The app never edits graphs — that stays in the web client.
struct WorkflowGraphView: View {
    let workflow: WorkflowItem

    private var nodes: [WorkflowNodeSummary] { WorkflowGraph.nodes(workflow) }
    private var edges: [WorkflowEdgeSummary] { WorkflowGraph.edges(workflow) }
    private var ordered: [WorkflowNodeSummary] { WorkflowGraph.ordered(nodes: nodes, edges: edges) }

    var body: some View {
        List {
            Section {
                Text("This is a read-only view. Design the graph in the Core Hub web or desktop client.")
                    .font(CoreHubTokens.Typography.metaFont)
                    .foregroundStyle(CoreHubTokens.Palette.textMuted)
            }
            Section("Nodes") {
                if ordered.isEmpty { Text("This workflow has no nodes yet.").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted) }
                ForEach(Array(ordered.enumerated()), id: \.element.id) { index, node in
                    nodeRow(index: index, node: node)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Graph summary")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func nodeRow(index: Int, node: WorkflowNodeSummary) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(verbatim: "\(index + 1)")
                    .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.meta, weight: .semibold))
                    .foregroundStyle(CoreHubTokens.Palette.textMuted)
                    .frame(width: 20)
                DirectionalText(text: node.title, font: CoreHubTokens.Typography.font(CoreHubTokens.Typography.sessionTitle, weight: .medium))
                Spacer(minLength: 0)
                if node.approvalRequired { StatusPill(text: String(localized: "Approval"), color: CoreHubTokens.Palette.warning) }
            }
            TechnicalText(text: [node.agent, node.agentMode, node.model].filter { !$0.isEmpty }.joined(separator: " · "))
            if !node.skills.isEmpty { TechnicalText(text: node.skills.joined(separator: ", ")) }
            if !node.input.isEmpty {
                DirectionalText(text: node.input, font: CoreHubTokens.Typography.metaFont, color: CoreHubTokens.Palette.textSecondary, lineLimit: 2)
            }
            ForEach(outgoing(node), id: \.self) { label in
                HStack(spacing: 6) {
                    CoreHubIconView(icon: .chevronForward, size: 11).foregroundStyle(CoreHubTokens.Palette.textMuted)
                    TechnicalText(text: label)
                }
            }
        }
        .padding(.vertical, 4)
    }

    /// "→ target (route)" for every edge that leaves this node.
    private func outgoing(_ node: WorkflowNodeSummary) -> [String] {
        edges.filter { $0.source == node.id }.map { edge in
            let title = nodes.first { $0.id == edge.target }?.title ?? edge.target
            return edge.route == "always" ? title : "\(title) — \(edge.route)"
        }
    }
}
