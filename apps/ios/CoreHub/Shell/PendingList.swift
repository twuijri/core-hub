// The pending list on the phone (proposed — owner to confirm): a bell in the top bar with how
// many things wait for the person — the approvals and questions of every profile they may enter
// (`sessions.listApprovals`, one call per profile), a room's seats' among them (their
// `room_id`, contract decision §96). Each is answered in the sheet, or opened where it lives.
import CoreHubClient
import Observation
import SwiftUI

/// The pure rules: oldest first, one of each, and where each thing opens.
enum PendingItems {
    static func merge(_ groups: [[Approval]]) -> [Approval] {
        var seen = Set<String>()
        return groups.flatMap { $0 }
            .filter { $0.status == .pending && seen.insert($0.id).inserted }
            .sorted { $0.createdAt < $1.createdAt }
    }

    /// Its room, its conversation, or Schedules for a workflow's step.
    static func destination(of approval: Approval) -> MainContent? {
        if let room = approval.roomId { return .room(roomID: room, profile: approval.profile) }
        if let session = approval.sessionId { return .chat(sessionID: session, profile: approval.profile) }
        if approval.workflowRunId != nil { return .destination(.schedules) }
        return nil
    }

    static func placeKey(of approval: Approval) -> String {
        if approval.roomId != nil { return "pending.in_room" }
        if approval.workflowRunId != nil { return "pending.in_workflow" }
        return "pending.in_chat"
    }
}

@MainActor
@Observable
final class PendingModel {
    private(set) var items: [Approval] = []
    var actionError: String?
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var listener: UUID?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    init(app: AppModel) {
        self.app = app
    }

    func start() {
        if listener == nil, let namespace = app?.sessions {
            // The sessions socket hears every profile: a room seat's questions arrive here too.
            listener = namespace.onEvent { [weak self] name, _ in
                guard name == "approval.requested" || name == "approval.resolved" else { return }
                self?.scheduleRefresh()
            }
        }
        refresh()
    }

    func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            refresh()
        }
    }

    func refresh() {
        guard let app else { return }
        let profiles = app.enterableProfiles.isEmpty ? [app.currentProfile] : app.enterableProfiles
        Task {
            var groups: [[Approval]] = []
            for slug in profiles {
                let page = try? await app.api.call {
                    try await SessionsAPI.sessionsListApprovals(xHubProfile: slug, status: .pending, limit: 100, apiConfiguration: $0)
                }
                groups.append(page?.items ?? [])
            }
            items = PendingItems.merge(groups)
        }
    }

    func respond(_ approval: Approval, decision: ApprovalDecision?, answer: String?) async {
        guard let app else { return }
        let profile = approval.profile
        do {
            _ = try await app.api.call {
                try await SessionsAPI.sessionsRespondApproval(
                    xHubProfile: profile, approvalId: approval.id,
                    approvalResponse: ApprovalResponse(decision: decision, answer: answer), apiConfiguration: $0
                )
            }
        } catch {
            let failure = HubFailure(error)
            if failure.status != 409 { actionError = failure.describe(app.l10n) }
        }
        items.removeAll { $0.id == approval.id }
        scheduleRefresh()
    }
}

struct PendingButton: View {
    let model: PendingModel
    let open: () -> Void
    @Environment(\.l10n) private var l10n

    var body: some View {
        Button(action: open) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "bell")
                if !model.items.isEmpty {
                    Text("\(model.items.count)")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Tone.accentText)
                        .padding(.horizontal, 4)
                        .background(Tone.accent, in: Capsule())
                        .offset(x: 8, y: -6)
                }
            }
        }
        .accessibilityLabel(l10n("pending.title"))
        .accessibilityValue(String(model.items.count))
        .accessibilityIdentifier("pending.open")
    }
}

struct PendingSheet: View {
    let model: PendingModel
    let go: (MainContent) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s4) {
                if model.items.isEmpty {
                    Text(l10n("pending.empty"))
                        .foregroundStyle(Tone.textMuted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Space.s8)
                }
                if let error = model.actionError { NoticeView(text: error, tone: .danger) }
                ForEach(model.items, id: \.id) { approval in
                    VStack(alignment: .leading, spacing: Space.s2) {
                        HStack(spacing: Space.s2) {
                            Text(l10n(PendingItems.placeKey(of: approval)))
                                .font(.system(size: FontSize.sizeXs, weight: .semibold))
                                .foregroundStyle(Tone.textMuted)
                            if app.enterableProfiles.count > 1 { ProfileBadge(name: app.profileName(approval.profile)) }
                            Spacer()
                            if let target = PendingItems.destination(of: approval) {
                                Button(l10n("pending.open")) {
                                    dismiss()
                                    go(target)
                                }
                                .font(.system(size: FontSize.sizeSm))
                                .accessibilityIdentifier("pending.go.\(approval.id)")
                            }
                        }
                        ApprovalCard(approval: approval) { decision, answer in
                            Task { await model.respond(approval, decision: decision, answer: answer) }
                        }
                    }
                }
            }
            .padding(Space.s4)
        }
        .navigationTitle(l10n("pending.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button(l10n("common.close")) { dismiss() } }
        }
        .onAppear { model.refresh() }
        .accessibilityIdentifier("pending.sheet")
    }
}
