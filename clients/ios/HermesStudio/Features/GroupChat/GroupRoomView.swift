import PhotosUI
import SwiftUI

/// One group-chat room: persistent `/group-chat` socket, the reduced room
/// state, the M3 message rows, per-agent activity, typing, the execution
/// queue, inline approvals and clarifications, and the handoff chains.
struct GroupRoomView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    let room: Room

    @State private var state = GroupRoomState()
    @State private var socket = GroupRoomSocket()
    @State private var connectionGeneration = 0
    @State private var input = ""
    @State private var sending = false
    @State private var uploads: [AttachmentUpload] = []
    @State private var uploadTasks: [String: Task<Void, Never>] = [:]
    @State private var loadingEarlier = false
    @State private var bottomVisible = true
    @State private var showingSettings = false
    @State private var showingPhotos = false
    @State private var showingCamera = false
    @State private var importing = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var typingSentAt = Date.distantPast
    @FocusState private var inputFocused: Bool

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                transcript(width: geometry.size.width)
                panels
                RoomComposer(text: $input, focused: $inputFocused, uploads: uploads, state: composerState, actions: composerActions)
            }
        }
        .background(CoreHubTokens.Palette.bgPrimary)
        .navigationTitle(state.roomName.nilIfEmpty ?? room.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .modifier(RoomSheets(view: self, showingSettings: $showingSettings, showingPhotos: $showingPhotos, showingCamera: $showingCamera, importing: $importing, photoItems: $photoItems))
        .task(id: "\(room.id)#\(connectionGeneration)") { await runStream() }
        .onChange(of: scenePhase) { _, phase in if phase == .active && !state.connected { connectionGeneration += 1 } }
        .onChange(of: input) { _, value in signalTyping(!value.isEmpty) }
    }

    // MARK: - Transcript

    private var lines: [GroupLine] {
        var result = GroupRunLines.lines(from: state.messages, agents: state.agents, currentUserID: myMemberID)
        result += GroupRunLines.interactionLines(state.pendingInteractions).map { GroupLine(line: $0, memberName: nil, agent: nil) }
        return result
    }

    private func transcript(width: CGFloat) -> some View {
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(spacing: 14) {
                    if state.hasMore { loadEarlierButton }
                    ForEach(lines) { item in
                        RoomLineRow(item: item, context: rowContext(width: width - 24, item: item)).id(item.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { bottomVisible = true }
                        .onDisappear { bottomVisible = false }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 16)
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await reloadDetail() }
            .onChange(of: state.messages) { _, _ in if bottomVisible { reader.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: state.joined) { _, joined in if joined { reader.scrollTo("bottom", anchor: .bottom) } }
        }
    }

    private var loadEarlierButton: some View {
        Button { Task { await loadEarlier() } } label: {
            HStack(spacing: 6) {
                if loadingEarlier { ProgressView().controlSize(.small) }
                Text(loadingEarlier ? "Loading…" : "Load earlier messages").font(CoreHubTokens.Typography.metaFont)
            }
            .foregroundStyle(CoreHubTokens.Palette.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .disabled(loadingEarlier)
    }

    @ViewBuilder private var panels: some View {
        if state.kicked { RoomNoticeRow(text: String(localized: "You were removed from this room."), error: true) }
        else if let error = state.connectionError, !state.joined { RoomNoticeRow(text: error, error: true) }
        else if !state.connected { ConnectionBanner(error: nil) }
        if !state.activeAgents.isEmpty {
            RoomActivityStrip(activities: state.activeAgents, agents: state.agents) { name in Task { await interrupt(name) } }
        }
        if !state.typingNames.isEmpty { RoomTypingRow(names: state.typingNames) }
        if !state.queue.isEmpty { RoomQueuePanel(items: state.queue) { item in Task { await cancelQueued(item) } } }
        if !state.stoppedHandoffs.isEmpty { RoomHandoffPanel(chains: state.stoppedHandoffs) { chain in Task { await continueHandoff(chain) } } }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) { DrawerButton() }
        ToolbarItem(placement: .principal) {
            ChatHeaderTitle(title: state.roomName.nilIfEmpty ?? room.name, workspace: WorkspaceChip.label(for: room.workspace), agent: memberSummary)
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button { showingSettings = true } label: { Label("Room settings", systemImage: "slider.horizontal.3") }
                Button { Task { await reloadDetail() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                Button { connectionGeneration += 1 } label: { Label("Reconnect", systemImage: "antenna.radiowaves.left.and.right") }
            } label: {
                CoreHubIconView(icon: .more, size: 22).foregroundStyle(CoreHubTokens.Palette.textPrimary).frame(width: 38, height: 38).contentShape(Rectangle())
            }
            .accessibilityLabel("Room options")
        }
    }

    private var memberSummary: String {
        let members = state.members.isEmpty ? room.memberCount : state.members.count
        let agents = state.agents.isEmpty ? room.agentCount : state.agents.count
        return String(localized: "\(members) members · \(agents) agents")
    }

    // MARK: - Context

    /// The room screen reuses the M3 rows, which are written against a
    /// session; this synthesises one from the room.
    private var roomSession: SessionSummary {
        SessionSummary([
            "id": room.id,
            "title": room.name,
            "profile": room.summaryProfile.nilIfEmpty ?? store.selectedProfile,
            "workspace": room.workspace,
            "agent": "hermes",
        ], profile: store.selectedProfile)
    }

    private var myMemberID: String {
        let username = store.currentUser?.username ?? ""
        if let member = state.members.first(where: { $0.name == username }) { return member.id }
        return String(store.currentUser?.id ?? 0)
    }

    private func rowContext(width: CGFloat, item: GroupLine) -> MessageRowContext {
        let asset = item.agent ?? AgentAvatarAsset.hermes
        return MessageRowContext(
            availableWidth: width, session: roomSession, api: store.api, agent: asset,
            showToolCalls: store.showToolCalls, canFork: false,
            isSpeaking: { _ in false },
            onSpeak: { _ in },
            onCopy: { UIPasteboard.general.string = $0.text; store.notify(String(localized: "Message copied")) },
            onReference: { line in input = ReferenceQuote.compose(quoted: line.text, reply: input); inputFocused = true },
            onFork: { _ in },
            onRespond: { interaction, answer in Task { await respond(to: interaction, with: answer) } },
            agentFor: { _ in asset },
            roomID: room.id
        )
    }

    private var composerState: RoomComposerState {
        RoomComposerState(connected: state.connected && state.joined && !state.kicked, sending: sending,
                          mentionNames: GroupMentions.suggestions(agents: state.agents, canMentionAll: room.canMentionAll))
    }

    private var composerActions: RoomComposerActions {
        var actions = RoomComposerActions()
        actions.send = { Task { await send() } }
        actions.attachCamera = { if CameraPicker.isAvailable { showingCamera = true } else { store.errorMessage = String(localized: "No camera is available on this device.") } }
        actions.attachPhotos = { showingPhotos = true }
        actions.attachFiles = { importing = true }
        actions.cancelUpload = { cancelUpload($0) }
        actions.insertMention = { name in input = GroupMentions.insert(name, into: input); inputFocused = true }
        return actions
    }

    // MARK: - Socket

    private func runStream() async {
        let name = store.currentUser?.username.nilIfEmpty ?? DeviceIdentity.defaultName
        for await event in socket.open(baseURL: store.baseURL, token: store.token, profile: store.selectedProfile, roomID: room.id, memberName: name) {
            GroupRoomReducer.apply(event, to: &state, currentUserID: myMemberID)
            if case let .joinFailed(message) = event { store.errorMessage = message }
        }
    }

    private func signalTyping(_ active: Bool) {
        guard state.joined else { return }
        if active {
            guard Date().timeIntervalSince(typingSentAt) > 2 else { return }
            typingSentAt = Date()
        } else {
            typingSentAt = .distantPast
        }
        socket.typing(active)
    }

    func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = uploads.compactMap(\.result)
        guard !text.isEmpty || !files.isEmpty else { return }
        guard !uploads.contains(where: { $0.phase == .uploading }) else {
            store.errorMessage = String(localized: "Wait for the attachments to finish uploading.")
            return
        }
        sending = true
        defer { sending = false }
        input = ""
        uploads = []
        inputFocused = false
        socket.typing(false)
        // Structured mentions are omitted on purpose: the server resolves
        // @mentions from the text for human senders and rejects metadata
        // that does not match exactly.
        let error = await socket.send(messageID: UUID().uuidString, content: ChatSocket.content(text, files), mentions: [])
        if let error {
            store.errorMessage = error
            input = text
        }
    }

    private func respond(to interaction: ChatInteraction, with answer: String) async {
        let error: String?
        switch interaction.kind {
        case .approval: error = await socket.respondToApproval(id: interaction.id, choice: answer)
        case .clarify: error = await socket.respondToClarification(id: interaction.id, answer: answer)
        }
        if let error { store.errorMessage = error }
    }

    private func interrupt(_ agentName: String) async {
        if let error = await socket.interruptAgent(named: agentName) { store.errorMessage = error }
    }

    private func cancelQueued(_ item: GroupQueueItem) async {
        if let error = await socket.cancelQueueItem(item.id) { store.errorMessage = error }
    }

    private func continueHandoff(_ chain: HandoffChain) async {
        guard let updated = await store.attempt({ try await store.api.continueRoomHandoff(room.id, chainID: chain.id) }) else { return }
        GroupRoomReducer.apply(.handoffUpdated(updated), to: &state, currentUserID: myMemberID)
    }

    // MARK: - History

    private func loadEarlier() async {
        guard !loadingEarlier, let oldest = state.oldestMessageID else { return }
        loadingEarlier = true
        defer { loadingEarlier = false }
        if let page = await socket.loadOlder(before: oldest) {
            GroupRoomReducer.prependHistory(page.messages, hasMore: page.hasMore, to: &state)
            return
        }
        guard let detail = await store.attempt({ try await store.api.roomDetail(room.id, before: oldest) }) else { return }
        GroupRoomReducer.prependHistory(detail.messages, hasMore: detail.hasMore, to: &state)
    }

    func reloadDetail() async {
        guard let detail = await store.attempt({ try await store.api.roomDetail(room.id) }) else { return }
        state.agents = detail.agents
        if !detail.members.isEmpty { state.members = detail.members }
        state.handoffs = detail.handoffs.filter(\.canContinue)
        state.roomName = detail.room.name
        state.totalTokens = detail.room.totalTokens
        if !state.joined {
            state.messages = detail.messages
            state.hasMore = detail.hasMore
        }
    }

    // MARK: - Attachments

    func addAttachment(_ picked: PickedAttachment) {
        let id = AppUploadPlan.makeID()
        uploads.append(AttachmentUpload(id: id, name: picked.name, mime: picked.mime, size: picked.data.count))
        let api = store.api
        let roomID = room.id
        uploadTasks[id] = Task {
            do {
                let result = try await api.uploadRoomAttachmentChunked(roomID: roomID, id: id, name: picked.name, mime: picked.mime, data: picked.data) { sent in
                    Task { @MainActor in updateUpload(id) { $0.sent = sent } }
                }
                updateUpload(id) { $0.phase = .done; $0.sent = $0.size; $0.result = result }
            } catch is CancellationError {
                updateUpload(id) { $0.phase = .cancelled }
            } catch {
                updateUpload(id) { $0.phase = .failed(error.localizedDescription) }
                store.errorMessage = error.localizedDescription
            }
            uploadTasks[id] = nil
        }
    }

    private func updateUpload(_ id: String, _ change: (inout AttachmentUpload) -> Void) {
        guard let index = uploads.firstIndex(where: { $0.id == id }) else { return }
        change(&uploads[index])
    }

    private func cancelUpload(_ id: String) {
        uploadTasks[id]?.cancel(); uploadTasks[id] = nil
        uploads.removeAll { $0.id == id }
    }

    func importFiles(_ urls: [URL]) {
        for url in urls {
            do { addAttachment(try PickedAttachment.load(url)) }
            catch { store.errorMessage = error.localizedDescription }
        }
    }

    func importPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            do { if let picked = try await PickedAttachment.load(item) { addAttachment(picked) } }
            catch { store.errorMessage = error.localizedDescription }
        }
        photoItems = []
    }
}

/// A one-line notice above the composer (kicked, join refused).
struct RoomNoticeRow: View {
    let text: String
    var error = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: error ? "exclamationmark.triangle.fill" : "info.circle").font(.system(size: 11))
            Text(text).font(CoreHubTokens.Typography.metaFont)
            Spacer(minLength: 0)
        }
        .foregroundStyle(error ? CoreHubTokens.Palette.error : CoreHubTokens.Palette.textSecondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background((error ? CoreHubTokens.Palette.error : CoreHubTokens.Palette.accent).opacity(CoreHubTokens.Alpha.hover))
    }
}

/// Sheets and pickers of the room, kept out of `body` for the type-checker.
private struct RoomSheets: ViewModifier {
    let view: GroupRoomView
    @Binding var showingSettings: Bool
    @Binding var showingPhotos: Bool
    @Binding var showingCamera: Bool
    @Binding var importing: Bool
    @Binding var photoItems: [PhotosPickerItem]
    @EnvironmentObject private var store: AppStore

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $showingSettings) {
                RoomSettingsView(room: view.room) { Task { await view.reloadDetail() } }.environmentObject(store)
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                switch result {
                case let .success(urls): view.importFiles(urls)
                case let .failure(error): store.errorMessage = error.localizedDescription
                }
            }
            .photosPicker(isPresented: $showingPhotos, selection: $photoItems, maxSelectionCount: 10, matching: .any(of: [.images, .videos]))
            .onChange(of: photoItems) { _, items in if !items.isEmpty { Task { await view.importPhotos(items) } } }
            .fullScreenCover(isPresented: $showingCamera) {
                CameraPicker { data, name in view.addAttachment(PickedAttachment(data: data, name: name, mime: "image/jpeg")) }
                    .ignoresSafeArea()
            }
    }
}
