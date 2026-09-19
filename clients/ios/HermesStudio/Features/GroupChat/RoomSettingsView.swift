import SwiftUI

/// Room settings: name and summary policy, workspace, the invite code with
/// its QR, the agent seats (with presets), the human members, clearing the
/// context, the rolling summary and the handoff chains.
struct RoomSettingsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let room: Room
    let onChanged: () -> Void

    @State private var draft: RoomConfigDraft
    @State private var workspace: String
    @State private var inviteCode: String
    @State private var agents: [RoomAgent] = []
    @State private var members: [RoomMember] = []
    @State private var handoffs: [HandoffChain] = []
    @State private var summary = ""
    @State private var summaryStatus = ""
    @State private var models: [ModelOption] = []
    @State private var editingSeat: RoomAgent?
    @State private var addingSeat = false
    @State private var configState: SaveState = .idle
    @State private var workspaceState: SaveState = .idle
    @State private var inviteState: SaveState = .idle
    @State private var summaryState: SaveState = .idle
    @State private var clearing = false

    init(room: Room, onChanged: @escaping () -> Void) {
        self.room = room
        self.onChanged = onChanged
        _draft = State(initialValue: RoomConfigDraft(room: room))
        _workspace = State(initialValue: room.workspace)
        _inviteCode = State(initialValue: room.inviteCode)
    }

    private var inviteURL: URL? { RoomInviteLink.url(server: store.baseURL, inviteCode: inviteCode) }

    var body: some View {
        NavigationStack {
            List {
                generalSection
                summaryPolicySection
                workspaceSection
                inviteSection
                agentsSection
                membersSection
                contextSection
                summarySection
                if !handoffs.isEmpty { handoffSection }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Room settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $addingSeat) {
                RoomAgentEditorView(input: RoomAgentInput(), models: models) { input in Task { await addSeat(input) } }
            }
            .sheet(item: $editingSeat) { seat in
                RoomAgentEditorView(input: RoomAgentInput(seat: seat), models: models) { input in Task { await updateSeat(seat, input: input) } }
            }
            .task { await load() }
        }
    }

    // MARK: Sections

    private var generalSection: some View {
        Section("Room") {
            TextField("Name", text: $draft.name).contentDirection(of: draft.name)
            SaveButton(title: String(localized: "Save room"), state: configState) { Task { await saveConfig() } }
        }
    }

    private var summaryPolicySection: some View {
        Section {
            Picker("Summary profile", selection: $draft.summaryProfile) { ForEach(store.profiles) { Text($0.name).tag($0.name) } }
            Picker("Summary model", selection: $draft.summaryModel) {
                Text("Profile default").tag("")
                ForEach(models) { Text($0.name).tag($0.id) }
            }
            Stepper("Summarize every \(draft.summaryEveryTurns) turns", value: $draft.summaryEveryTurns, in: RoomCreateDraft.turnRange)
            Toggle("Agent handoff", isOn: $draft.handoffEnabled)
            if draft.handoffEnabled {
                Toggle("Unlimited depth", isOn: $draft.handoffUnlimited)
                if !draft.handoffUnlimited {
                    Stepper("Maximum depth \(draft.handoffMaxDepth)", value: $draft.handoffMaxDepth, in: 1...20)
                }
            }
        } header: { Text("Summary and handoff") } footer: { Text("Saved together with the room name.") }
    }

    private var workspaceSection: some View {
        Section("Workspace") {
            TextField("Workspace path", text: $workspace).textInputAutocapitalization(.never).autocorrectionDisabled()
            SaveButton(title: String(localized: "Save workspace"), state: workspaceState) { Task { await saveWorkspace() } }
        }
    }

    private var inviteSection: some View {
        Section {
            if let inviteURL { RoomInviteQRView(link: inviteURL, inviteCode: inviteCode) }
            else { Text("Set the Core Hub address to build an invite link.").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted) }
            HStack {
                TextField("Invite code", text: $inviteCode).textInputAutocapitalization(.characters).autocorrectionDisabled()
                Button { inviteCode = RoomInviteLink.generateCode() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).accessibilityLabel("Generate invite code")
            }
            SaveButton(title: String(localized: "Save invite code"), state: inviteState) { Task { await saveInvite() } }
        } header: { Text("Invite") } footer: { Text("Anyone with this code can join the room until you change it.") }
    }

    private var agentsSection: some View {
        Section("Agents") {
            ForEach(agents) { seat in
                Button { editingSeat = seat } label: { seatRow(seat) }
                    .buttonStyle(.plain)
                    .swipeActions {
                        Button(role: .destructive) { Task { await removeSeat(seat) } } label: { Label("Remove", systemImage: "trash") }
                    }
            }
            Button { addingSeat = true } label: { Label("Add agent", systemImage: "plus.circle") }
        }
    }

    private func seatRow(_ seat: RoomAgent) -> some View {
        HStack(spacing: 10) {
            AgentAvatarView(asset: seat.avatarAsset, size: 26)
            VStack(alignment: .leading, spacing: 2) {
                DirectionalText(text: seat.name, font: CoreHubTokens.Typography.font(CoreHubTokens.Typography.sessionTitle, weight: .medium))
                TechnicalText(text: [seat.agent, seat.profile, seat.model].filter { !$0.isEmpty }.joined(separator: " · "))
            }
            Spacer(minLength: 0)
            if seat.isRemote { StatusPill(text: seat.connectionStatus.nilIfEmpty ?? String(localized: "Remote"), color: CoreHubTokens.Palette.info) }
        }
        .contentShape(Rectangle())
    }

    private var membersSection: some View {
        Section("Members") {
            if members.isEmpty { Text("No members yet").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted) }
            ForEach(members) { member in
                HStack(spacing: 10) {
                    ProfileAvatar(name: member.name, size: 26)
                    DirectionalText(text: member.name, font: CoreHubTokens.Typography.sessionTitleFont)
                    Spacer(minLength: 0)
                    Circle().fill(member.online ? CoreHubTokens.Palette.success : CoreHubTokens.Palette.textMuted).frame(width: 7, height: 7)
                }
                .swipeActions {
                    Button(role: .destructive) { Task { await removeMember(member) } } label: { Label("Remove", systemImage: "person.badge.minus") }
                }
            }
        }
    }

    private var contextSection: some View {
        Section {
            LabeledContent("Tokens in context") { Text(verbatim: "\(room.totalTokens)").environment(\.layoutDirection, .leftToRight) }
            Button(role: .destructive) { Task { await clearContext() } } label: {
                HStack { if clearing { ProgressView().controlSize(.small) }; Text("Clear context") }
            }
            .disabled(clearing)
        } header: { Text("Context") } footer: { Text("Clearing removes the transcript the agents see; the messages stay in the room history on the server.") }
    }

    private var summarySection: some View {
        Section {
            if !summaryStatus.isEmpty { StatusPill(text: summaryStatus, color: summaryStatus == "error" ? CoreHubTokens.Palette.error : CoreHubTokens.Palette.info) }
            TextField("Room summary", text: $summary, axis: .vertical).lineLimit(3...12).contentDirection(of: summary)
            SaveButton(title: String(localized: "Save summary"), state: summaryState) { Task { await saveSummary() } }
        } header: { Text("Summary") } footer: { Text("Core Hub rewrites this automatically; edit it when the agents need a different starting point.") }
    }

    private var handoffSection: some View {
        Section("Handoff chains") {
            ForEach(handoffs) { chain in
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        TechnicalText(text: chain.id, font: CoreHubTokens.Typography.metaFont, color: CoreHubTokens.Palette.textSecondary)
                        Text("Depth \(chain.currentDepth) of \(chain.maxDepth ?? chain.currentDepth)").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted)
                    }
                    Spacer(minLength: 0)
                    if chain.canContinue {
                        Button("Continue") { Task { await continueChain(chain) } }.buttonStyle(CoreHubPillButtonStyle())
                    } else {
                        StatusPill(text: chain.status, color: CoreHubTokens.Palette.textMuted)
                    }
                }
            }
        }
    }

    // MARK: Data

    private func load() async {
        models = (await store.attempt({ try await store.api.models(profile: store.selectedProfile) })) ?? []
        agents = (await store.attempt({ try await store.api.roomAgents(room.id) })) ?? agents
        handoffs = (await store.attempt({ try await store.api.roomHandoffs(room.id) })) ?? handoffs
        if let detail = await store.attempt({ try await store.api.roomDetail(room.id, limit: 1) }) { members = detail.members }
        if let state = await store.attempt({ try await store.api.roomSummary(room.id) }) {
            summary = state.summary
            summaryStatus = state.status == "idle" ? "" : state.status
        }
    }

    private func saveConfig() async {
        configState = .saving
        do {
            _ = try await store.api.updateRoomConfig(room.id, config: draft.body)
            configState = .saved
            onChanged(); store.roomsChanged()
        } catch { configState = .failed(error.localizedDescription) }
    }

    private func saveWorkspace() async {
        workspaceState = .saving
        do {
            _ = try await store.api.updateRoomWorkspace(room.id, workspace: workspace)
            workspaceState = .saved
            onChanged()
        } catch { workspaceState = .failed(error.localizedDescription) }
    }

    private func saveInvite() async {
        inviteState = .saving
        do {
            try await store.api.updateRoomInviteCode(room.id, inviteCode: inviteCode)
            inviteState = .saved
            onChanged(); store.roomsChanged()
        } catch { inviteState = .failed(error.localizedDescription) }
    }

    private func saveSummary() async {
        summaryState = .saving
        do {
            let state = try await store.api.updateRoomSummary(room.id, summary: summary)
            summary = state.summary
            summaryState = .saved
        } catch { summaryState = .failed(error.localizedDescription) }
    }

    private func clearContext() async {
        clearing = true
        defer { clearing = false }
        guard await store.attempt({ try await store.api.clearRoomContext(room.id) }) != nil else { return }
        store.notify(String(localized: "Room context cleared"))
        onChanged()
    }

    private func addSeat(_ input: RoomAgentInput) async {
        guard let seat = await store.attempt({ try await store.api.addRoomAgent(room.id, input: input) }) else { return }
        agents.append(seat)
        onChanged(); store.roomsChanged()
    }

    private func updateSeat(_ seat: RoomAgent, input: RoomAgentInput) async {
        guard let updated = await store.attempt({ try await store.api.updateRoomAgent(room.id, agentID: seat.agentID, input: input) }) else { return }
        if !updated.isEmpty { agents = updated }
        onChanged()
    }

    private func removeSeat(_ seat: RoomAgent) async {
        guard await store.attempt({ try await store.api.removeRoomAgent(room.id, agentID: seat.agentID) }) != nil else { return }
        agents.removeAll { $0.id == seat.id }
        onChanged(); store.roomsChanged()
    }

    private func removeMember(_ member: RoomMember) async {
        guard await store.attempt({ try await store.api.removeRoomMember(room.id, userID: member.userID) }) != nil else { return }
        members.removeAll { $0.id == member.id }
        onChanged()
    }

    private func continueChain(_ chain: HandoffChain) async {
        guard let updated = await store.attempt({ try await store.api.continueRoomHandoff(room.id, chainID: chain.id) }) else { return }
        if let index = handoffs.firstIndex(where: { $0.id == updated.id }) { handoffs[index] = updated }
    }
}
