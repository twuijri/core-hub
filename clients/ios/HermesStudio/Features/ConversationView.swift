import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// One conversation: persistent `/chat-run` socket, message stream reduced
/// by `ChatRunReducer`, the M3 composer, inline approvals, media, TTS and
/// mobile consent sheets.
struct ConversationView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    let session: SessionSummary
    /// True when shown as the shell's root (hamburger instead of back).
    var embeddedInShell = false

    @State var stream = ChatStreamState()
    @State var loading = true
    @State var input = ""
    @State var uploads: [AttachmentUpload] = []
    @State var uploadTasks: [String: Task<Void, Never>] = [:]
    @State var reference: ChatLine?
    @State var models: [ModelOption] = []
    @State var selectedModel = ""
    @State var selectedProvider = ""
    @State var contextWindow = 0
    @State var loadingContext = false
    @State var socket = ChatSocket()
    /// Whether the server knows this session id yet; `nil` until something
    /// proves it either way. A local draft starts unknown so no per-session
    /// event is fired before the first run.
    @State var sessionKnown: Bool?
    /// Bumped to reopen the socket (foreground after a long background).
    @State var connectionGeneration = 0
    @State var hasConnectedOnce = false
    /// Offset of the oldest loaded page (`messages/paginated`); nil = whole history loaded.
    @State var historyOffset: Int?
    @State var loadingEarlier = false
    @StateObject var recorder = VoiceRecorder()
    @StateObject var speech = OnDeviceSpeechRecognizer()
    @StateObject var speaker = MessageSpeaker()
    @State var voiceState: ComposerVoiceState = .idle
    /// Composer text captured when dictation started; live partial results are appended after it.
    @State var voiceBase = ""
    @State var serverSttProvider = ""
    @State var voiceReplyPending = false
    @State private var bottomVisible = true
    @State private var showingNewSession = false
    @State private var showingSessionSettings = false
    @State private var showingRename = false
    @State private var renameText = ""
    @State private var importing = false
    @State private var showingPhotos = false
    @State private var showingCamera = false
    @State private var photoItems: [PhotosPickerItem] = []
    @FocusState var inputFocused: Bool

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                messageList(width: geometry.size.width)
                if hasConnectedOnce && !stream.connected { ConnectionBanner(error: stream.connectionError) }
                if let compression = stream.compression { CompressionBanner(compression: compression) }
                if let phase = stream.abortPhase { AbortBanner(phase: phase) }
                if !stream.queued.isEmpty {
                    QueuedRunsPanel(items: stream.queued, insertionID: stream.queueInsertionID,
                                    onInsert: { socket.insertQueued(sessionID: session.id, queueID: $0.id) },
                                    onSteer: { socket.steerQueued(sessionID: session.id, queueID: $0.id) },
                                    onCancel: { item in socket.cancelQueued(sessionID: session.id, queueID: item.id); stream.queued.removeAll { $0.id == item.id } })
                }
                if !stream.workspaceChanges.isEmpty { WorkspaceChangesRow(changes: stream.workspaceChanges, workspace: stream.workspace) }
                ChatComposer(text: $input, focused: $inputFocused, uploads: uploads, reference: reference, state: composerState, actions: composerActions, availableWidth: geometry.size.width)
            }
        }
        .background(CoreHubTokens.Palette.bgPrimary)
        .navigationTitle(displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbarBackground(CoreHubTokens.Palette.bgPrimary, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar { toolbarContent }
        .modifier(ConversationSheets(view: self, showingNewSession: $showingNewSession, showingSessionSettings: $showingSessionSettings, showingRename: $showingRename, renameText: $renameText, importing: $importing, showingPhotos: $showingPhotos, showingCamera: $showingCamera, photoItems: $photoItems))
        .task(id: "\(session.id)#\(connectionGeneration)") { await runStream() }
        .task(id: session.id) { await reload(); await loadModels(); await VoiceOutputStore.shared.load(profile: session.profile, api: store.api) }
        // A failed server voice already fell back to the iPhone voice; the
        // banner says which provider failed and why.
        .onChange(of: speaker.failure) { _, message in
            guard let message else { return }
            store.errorMessage = message
            speaker.clearFailure()
        }
        .onChange(of: scenePhase) { _, phase in
            // Studio keeps running after the app is backgrounded: reconnect at
            // once instead of waiting for the backoff timer, and pull history.
            if phase == .active {
                if !stream.connected { connectionGeneration += 1 } else { socket.resumeApp(sessionID: session.id) }
                Task { await reload() }
            }
        }
        // The drawer opens over the composer: drop focus with it so the
        // keyboard does not stay up covering the drawer.
        .onChange(of: store.drawerOpen) { _, open in if open { inputFocused = false } }
        .onDisappear { speaker.stop(); speech.cancel(); if recorder.isRecording { _ = recorder.stop() }; voiceState = .idle }
    }

    // MARK: - Pieces

    private func messageList(width: CGFloat) -> some View {
        ScrollViewReader { reader in
            ZStack(alignment: .bottomTrailing) {
                ScrollView {
                    LazyVStack(spacing: 14) {
                        if loading && stream.lines.isEmpty { ProgressView().padding(.top, 40) }
                        if stream.sessionMissing && stream.lines.isEmpty { MissingSessionNotice() }
                        if let offset = historyOffset, offset > 0 {
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
                            .onAppear { if !loadingEarlier { Task { await loadEarlier() } } }
                        }
                        ForEach(stream.lines) { line in
                            MessageRow(line: line, context: rowContext(width: width - 24)).id(line.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                            .onAppear { bottomVisible = true }
                            .onDisappear { bottomVisible = false }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 16)
                }
                if !bottomVisible && !stream.lines.isEmpty { JumpToLatestButton { withAnimation(.easeOut(duration: CoreHubTokens.Motion.normal)) { reader.scrollTo("bottom", anchor: .bottom) } } }
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await reload() }
            .onChange(of: stream.lines) { _, _ in if bottomVisible || stream.isRunning { reader.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: loading) { _, value in if !value { Task { try? await Task.sleep(for: .milliseconds(120)); reader.scrollTo("bottom", anchor: .bottom) } } }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            if embeddedInShell {
                DrawerButton()
            } else {
                Button { dismiss() } label: {
                    CoreHubIconView(icon: .back, size: 22).foregroundStyle(CoreHubTokens.Palette.textPrimary).frame(width: 38, height: 38).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("Back")
            }
        }
        ToolbarItem(placement: .principal) { ChatHeaderTitle(title: displayTitle, workspace: workspaceLabel, agent: session.agentDisplayName) }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button { Task { await reload() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                Button { store.startNewChat(agent: session.agentID) } label: { Label("New conversation", systemImage: "plus.bubble") }
                Button { showingNewSession = true } label: { Label("New conversation with agent…", systemImage: "cpu") }
                Button { fork() } label: { Label("Fork conversation", systemImage: "arrow.triangle.branch") }.disabled(stream.isRunning)
                Divider()
                Button { renameText = displayTitle; showingRename = true } label: { Label("Rename", systemImage: "pencil") }
                Button { showingSessionSettings = true } label: { Label("Session settings", systemImage: "slider.horizontal.3") }
                Button { Task { await archiveSession() } } label: { Label("Archive", systemImage: "archivebox") }
                Button(role: .destructive) { Task { await deleteSession() } } label: { Label("Delete", systemImage: "trash") }
            } label: {
                CoreHubIconView(icon: .more, size: 22).foregroundStyle(CoreHubTokens.Palette.textPrimary).frame(width: 38, height: 38).contentShape(Rectangle())
            }
            .accessibilityLabel("Conversation options")
        }
    }

    var agentAsset: AgentAvatarAsset { AgentAvatarAsset.resolve(session: session) }
    var agentLabel: String { agentAsset.label }
    /// The shell keeps the live title after a rename; a pushed copy uses its own.
    var displayTitle: String { stream.title ?? (store.selectedSession?.id == session.id ? store.selectedSession?.title : nil) ?? session.title }
    var workspaceLabel: String { WorkspaceChip.label(for: stream.workspace.nilIfEmpty ?? session.workspace) }

    private func rowContext(width: CGFloat) -> MessageRowContext {
        MessageRowContext(
            availableWidth: width, session: session, api: store.api, agent: agentAsset,
            showToolCalls: store.showToolCalls, canFork: !stream.isRunning,
            isSpeaking: { speaker.isPlaying($0.id) },
            onSpeak: { speak($0) },
            onCopy: { UIPasteboard.general.string = $0.text; store.notify(String(localized: "Message copied")) },
            onReference: { reference = $0; inputFocused = true },
            onFork: { _ in fork() },
            onRespond: { interaction, answer in respond(to: interaction, with: answer) }
        )
    }

    var composerState: ChatComposerState {
        ChatComposerState(
            isRunning: stream.isRunning, contextTokens: stream.contextTokens, contextWindow: stream.contextWindow > 0 ? stream.contextWindow : contextWindow,
            loadingContext: loadingContext, models: models, selectedModel: selectedModel,
            reasoningEffort: stream.reasoningEffort ?? store.reasoningEffort, showToolCalls: store.showToolCalls, voiceMode: store.autoSpeakReplies,
            pushEnabled: stream.pushEnabled ?? session.pushEnabled, profile: session.profile,
            voiceState: voiceState, isRecording: recorder.isRecording, recordingElapsed: recorder.elapsed
        )
    }

    var composerActions: ChatComposerActions {
        var actions = ChatComposerActions()
        actions.send = { send() }
        actions.stop = { socket.abort(sessionID: session.id); if !socket.isConnected { finishLocally() } }
        actions.queue = { queueCurrentMessage() }
        actions.mic = { Task { await voice() } }
        actions.attachCamera = { if CameraPicker.isAvailable { showingCamera = true } else { store.errorMessage = String(localized: "No camera is available on this device.") } }
        actions.attachPhotos = { showingPhotos = true }
        actions.attachFiles = { importing = true }
        actions.cancelUpload = { cancelUpload($0) }
        actions.selectModel = { model in selectedModel = model.id; selectedProvider = model.provider; Task { await refreshContextWindow() } }
        actions.selectReasoning = { value in store.setReasoning(value); stream.reasoningEffort = value }
        actions.toggleToolCalls = { store.setShowToolCalls(!store.showToolCalls) }
        actions.toggleVoiceMode = { store.setAutoSpeakReplies(!store.autoSpeakReplies) }
        actions.togglePush = { togglePush() }
        actions.cancelReference = { reference = nil }
        return actions
    }

    // MARK: - Stream

    /// The server knows this id unless it is a fresh local draft or it just
    /// told us the session is gone.
    var sessionExistsOnServer: Bool { sessionKnown ?? !session.isLocalDraft }

    private func setSessionKnown(_ known: Bool) {
        sessionKnown = known
        if known { socket.markSessionExists() } else { socket.markSessionGone() }
    }

    private func runStream() async {
        for await event in socket.open(baseURL: store.baseURL, token: store.token, profile: session.profile, sessionID: session.id, sessionExists: sessionExistsOnServer) {
            handle(event)
        }
    }

    func handle(_ event: LiveRunEvent) {
        let wasRunning = stream.isRunning
        ChatRunReducer.apply(event, to: &stream, sender: agentLabel)
        switch event {
        case .connected:
            hasConnectedOnce = true
        case let .titleUpdated(title):
            if store.selectedSession?.id == session.id { store.selectedSession?.title = title }
            store.sessionsChanged()
        case let .settingsUpdated(settings):
            if !settings.model.isEmpty && settings.model != selectedModel { selectedModel = settings.model; selectedProvider = settings.provider; Task { await refreshContextWindow() } }
        case let .resumeState(resume):
            if !resume.model.isEmpty && selectedModel.isEmpty { selectedModel = resume.model; selectedProvider = resume.provider; Task { await refreshContextWindow() } }
        case let .deviceRequested(kind, id):
            socket.denyDeviceRequest(kind: kind, sessionID: session.id, requestID: id)
        case let .failed(message, _):
            if ChatRunReducer.isSessionGone(message) {
                // Not an error the user can act on: the stored id points at a
                // session the server no longer has. Forget it, leave the
                // neutral empty state, and let the next send create one.
                setSessionKnown(false)
                Preferences.setSession("", profile: session.profile)
                store.sessionsChanged()
            } else {
                store.errorMessage = message
            }
        default:
            break
        }
        if wasRunning && !stream.isRunning { runDidFinish() }
    }

    private func runDidFinish() {
        let wantsVoice = voiceReplyPending || store.autoSpeakReplies
        voiceReplyPending = false
        if wantsVoice, let reply = stream.lines.last(where: { $0.kind == .assistant && !$0.text.isEmpty }) { speak(reply) }
        Preferences.setSession(session.id, profile: session.profile)
        // The server may have created or retitled the session; refresh the drawer.
        store.sessionsChanged()
    }

    /// Used when the socket is down and a stop was requested.
    private func finishLocally() {
        ChatRunReducer.apply(.abort(phase: "completed"), to: &stream, sender: agentLabel)
    }

    // MARK: - Sending

    private var composerIsEmpty: Bool { input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !uploads.contains { $0.phase == .done } }

    func send() {
        guard !stream.isRunning else { socket.abort(sessionID: session.id); return }
        guard !uploads.contains(where: { $0.phase == .uploading }) else { store.errorMessage = String(localized: "Wait for the attachments to finish uploading."); return }
        // Sending always ends dictation; the text already in the field is what goes out.
        if speech.isActive { speech.cancel() }
        if recorder.isRecording { _ = recorder.stop() }
        voiceState = .idle
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = uploads.compactMap(\.result)
        guard !text.isEmpty || !files.isEmpty else { return }
        if let reference { text = ReferenceQuote.compose(quoted: reference.text, reply: text); self.reference = nil }
        input = ""; uploads = []; inputFocused = false
        let payload = ChatSocket.runPayload(profile: session.profile, sessionID: session.id, input: text, attachments: files, reasoningEffort: (stream.reasoningEffort ?? store.reasoningEffort).nilIfEmpty, model: selectedModel.nilIfEmpty, provider: selectedProvider.nilIfEmpty, session: session, pushEnabled: stream.pushEnabled)
        ChatRunReducer.beginRun(&stream, text: text.isEmpty ? files.map(\.name).joined(separator: ", ") : text, attachments: files.map { ChatAttachmentRef(name: $0.name, path: $0.path, mime: $0.mime) }, sender: agentLabel)
        if socket.run(payload) { setSessionKnown(true) } else { Task { await restFallback(text: text, files: files) } }
    }

    func sendCommand(_ command: String) {
        input = command
        send()
    }

    private func fork() { guard !stream.isRunning else { return }; sendCommand("/fork") }

    private func queueCurrentMessage() {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = uploads.compactMap(\.result)
        guard !text.isEmpty || !files.isEmpty else { return }
        if let reference { text = ReferenceQuote.compose(quoted: reference.text, reply: text); self.reference = nil }
        let payload = ChatSocket.runPayload(profile: session.profile, sessionID: session.id, input: text, attachments: files, reasoningEffort: (stream.reasoningEffort ?? store.reasoningEffort).nilIfEmpty, model: selectedModel.nilIfEmpty, provider: selectedProvider.nilIfEmpty, session: session, pushEnabled: stream.pushEnabled)
        guard socket.enqueue(payload) else { store.errorMessage = String(localized: "Not connected to Core Hub; the message was not queued."); return }
        input = ""; uploads = []; inputFocused = false
    }

    private func restFallback(text: String, files: [Upload]) async {
        do {
            let result = try await store.api.runChatREST(profile: session.profile, sessionID: session.id, input: text, attachments: files, reasoningEffort: (stream.reasoningEffort ?? store.reasoningEffort).nilIfEmpty, model: selectedModel.nilIfEmpty, provider: selectedProvider.nilIfEmpty)
            setSessionKnown(true)
            handle(.completed(output: result.0, reasoning: result.1, interrupted: false))
        } catch {
            handle(.failed(error.localizedDescription, retryable: false))
        }
    }

    private func respond(to interaction: ChatInteraction, with answer: String) {
        switch interaction.kind {
        case .approval: socket.respondToApproval(sessionID: session.id, approvalID: interaction.id, choice: answer)
        case .clarify: socket.respondToClarification(sessionID: session.id, clarificationID: interaction.id, answer: answer)
        }
        if !socket.isConnected { store.errorMessage = String(localized: "Not connected to Core Hub; the response could not be sent.") }
    }

    private func togglePush() {
        let next = !(stream.pushEnabled ?? session.pushEnabled)
        stream.pushEnabled = next
        Task { await store.attempt { try await store.api.setSessionPush(session.id, enabled: next) } }
    }

    /// The spoken reply follows the profile's server voice (Settings → Voice),
    /// which loads the TTS settings and sends `provider` plus that provider's
    /// stored options. Only the explicit "This device" choice skips the
    /// server; a failure falls back to the iPhone voice *and* says why.
    func speak(_ line: ChatLine) {
        let profile = session.profile
        let api = store.api
        let voice = VoiceOutputStore.shared
        var synthesize: (() async throws -> Data)?
        if voice.choice(for: profile) != .device {
            synthesize = { try await voice.synthesize(text: line.text, profile: profile, api: api) }
        }
        speaker.toggle(lineID: line.id, text: line.text, languageCode: store.speechLocaleIdentifier, synthesize: synthesize)
    }

    // MARK: - Session management

    private func renameSession(_ title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await store.attempt { try await store.api.renameSession(session.id, title: trimmed) }
        if store.selectedSession?.id == session.id { store.selectedSession?.title = trimmed }
        stream.title = trimmed
        store.sessionsChanged()
    }

    private func archiveSession() async {
        await store.attempt { try await store.api.setSessionArchived(session.id, archived: true) }
        store.sessionsChanged()
        if embeddedInShell { store.selectedSession = nil } else { dismiss() }
    }

    private func deleteSession() async {
        await store.attempt { try await store.api.deleteSession(session.id) }
        store.sessionsChanged()
        if embeddedInShell { store.selectedSession = nil } else { dismiss() }
    }

    func reload() async {
        loading = true
        do {
            // Newest page first (`messages/paginated`), older pages on demand;
            // the flat history endpoint remains the fallback.
            let probe = try await store.api.messagePage(sessionID: session.id, offset: 0, limit: 1, profile: session.profile)
            let offset = MessagePaging.lastPageOffset(total: probe.total)
            let page = probe.total <= 1 ? probe : try await store.api.messagePage(sessionID: session.id, offset: offset, limit: MessagePaging.pageSize, profile: session.profile)
            setSessionKnown(true)
            stream.sessionMissing = false
            if !stream.isRunning {
                stream.lines = Message.transcriptRows(page.messages).map(historyLine)
                stream.activeReplyID = nil
                historyOffset = probe.total <= 1 ? 0 : offset
            }
        } catch {
            do {
                let history = try await store.api.conversationHistory(sessionID: session.id)
                setSessionKnown(true)
                stream.sessionMissing = false
                if !stream.isRunning {
                    stream.lines = Message.transcriptRows(history.messages).map(historyLine)
                    stream.activeReplyID = nil
                    historyOffset = nil
                }
                if let tokens = history.contextTokens { stream.contextTokens = tokens }
            } catch {
                guard !Self.isMissingSession(error) else {
                    // The id is not on the server: a draft that has never
                    // been sent, or a session deleted elsewhere. Stop every
                    // per-session event and show one neutral empty state
                    // instead of an error per attempt. A run in flight has
                    // just created the session, so it is never demoted.
                    if !stream.isRunning {
                        setSessionKnown(false)
                        stream.sessionMissing = !session.isLocalDraft
                    }
                    historyOffset = nil
                    loading = false
                    return
                }
                if stream.lines.isEmpty && session.title != String(localized: "New conversation") { store.errorMessage = error.localizedDescription }
            }
        }
        loading = false
    }

    /// A session the server cannot resolve: the paginated route answers 404
    /// ("Conversation not found"), the socket "Session not found".
    static func isMissingSession(_ error: Error) -> Bool {
        guard let hermes = error as? HermesError else { return false }
        switch hermes {
        case let .http(code, detail): return code == 404 || ChatRunReducer.isSessionGone(detail)
        case let .server(message): return ChatRunReducer.isSessionGone(message)
        default: return false
        }
    }

    /// Prepends the previous page of history (infinite scroll upwards).
    func loadEarlier() async {
        guard !loadingEarlier, let current = historyOffset, let window = MessagePaging.earlierWindow(currentOffset: current) else { return }
        loadingEarlier = true
        defer { loadingEarlier = false }
        guard let page = await store.attempt({ try await store.api.messagePage(sessionID: session.id, offset: window.offset, limit: window.limit, profile: session.profile) }) else { return }
        let known = Set(stream.lines.compactMap(\.remoteID))
        let earlier = Message.transcriptRows(page.messages.filter { !known.contains($0.id) }).map(historyLine)
        stream.lines.insert(contentsOf: earlier, at: 0)
        historyOffset = window.offset
    }

    private func historyLine(_ row: (message: Message, kind: ChatLineKind)) -> ChatLine {
        let (message, kind) = row
        return ChatLine(id: StableID.uuid("history:\(session.id):\(message.id)"), text: message.content, fromUser: kind == .user, timestamp: message.sentAt, sender: kind == .assistant ? agentLabel : nil, reasoning: message.reasoning, kind: kind, attachments: message.attachments, remoteID: message.id)
    }

    private func loadModels() async {
        models = (await store.attempt({ try await store.api.models(profile: session.profile) })) ?? []
        if selectedModel.isEmpty {
            selectedModel = session.model.nilIfEmpty ?? store.preferredModel.nilIfEmpty ?? store.profiles.first { $0.name == session.profile }?.model ?? models.first?.id ?? ""
            selectedProvider = models.first { $0.id == selectedModel }?.provider ?? session.provider
        }
        await refreshContextWindow()
    }

    func refreshContextWindow() async {
        loadingContext = true
        do { contextWindow = try await store.api.contextLength(profile: session.profile, provider: selectedProvider, model: selectedModel) }
        catch HermesError.malformedResponse { /* Studio does not know this model's window; keep the last value. */ }
        catch { store.errorMessage = error.localizedDescription }
        loadingContext = false
    }

    // MARK: - Attachments (chunked app-uploads)

    func addAttachment(_ picked: PickedAttachment) {
        let id = AppUploadPlan.makeID()
        uploads.append(AttachmentUpload(id: id, name: picked.name, mime: picked.mime, size: picked.data.count))
        let profile = session.profile
        let api = store.api
        uploadTasks[id] = Task {
            do {
                let result = try await api.uploadAttachment(id: id, name: picked.name, mime: picked.mime, data: picked.data, profile: profile) { sent in
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

    func respondToLocation(_ decision: LocationConsentSheet.LocationDecision) {
        guard let request = stream.pendingLocation else { return }
        switch decision {
        case let .share(payload): socket.respondToLocation(payload)
        case .deny: socket.respondToLocation(LocationResponsePayload.denied(sessionID: request.sessionID, requestID: request.id))
        case let .error(payload): socket.respondToLocation(payload); store.errorMessage = (payload["error"] as? JSON)?.string("message")
        }
        stream.pendingLocation = nil
    }
}

/// Sheets, alerts and pickers of the conversation, kept out of `body` so the
/// type-checker stays fast.
private struct ConversationSheets: ViewModifier {
    let view: ConversationView
    @Binding var showingNewSession: Bool
    @Binding var showingSessionSettings: Bool
    @Binding var showingRename: Bool
    @Binding var renameText: String
    @Binding var importing: Bool
    @Binding var showingPhotos: Bool
    @Binding var showingCamera: Bool
    @Binding var photoItems: [PhotosPickerItem]
    @EnvironmentObject private var store: AppStore

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $showingNewSession) { NewCodingSessionView(categories: []).environmentObject(store) }
            .sheet(isPresented: $showingSessionSettings) { SessionManagementView(session: view.session, categories: []) { store.sessionsChanged() }.environmentObject(store) }
            .alert("Rename conversation", isPresented: $showingRename) {
                TextField("Title", text: $renameText)
                Button("Save") { Task { await view.renameSessionFromAlert(renameText) } }
                Button("Cancel", role: .cancel) {}
            }
            .sheet(item: Binding(get: { view.stream.pendingLocation }, set: { if $0 == nil { view.respondToLocation(.deny) } })) { request in
                LocationConsentSheet(request: request) { view.respondToLocation($0) }
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

extension ConversationView {
    func renameSessionFromAlert(_ title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await store.attempt { try await store.api.renameSession(session.id, title: trimmed) }
        if store.selectedSession?.id == session.id { store.selectedSession?.title = trimmed }
        stream.title = trimmed
        store.sessionsChanged()
    }
}

private struct JumpToLatestButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.headline.weight(.semibold))
                .foregroundStyle(CoreHubTokens.Palette.textPrimary)
                .frame(width: 40, height: 40)
                .background(CoreHubTokens.Palette.bgCard, in: Circle())
                .overlay(Circle().stroke(CoreHubTokens.Palette.border))
                .coreHubShadow(CoreHubTokens.Shadow.card)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Jump to latest message")
        .padding(14)
    }
}

/// Chat header: title 16/600 with per-string direction, workspace chip
/// (folder 12, 11 pt muted, radius 4, last path segment).
struct ChatHeaderTitle: View {
    let title: String
    var workspace: String = ""
    var agent: String = ""

    var body: some View {
        VStack(spacing: 1) {
            Text(title)
                .font(CoreHubTokens.Typography.titleFont)
                .foregroundStyle(CoreHubTokens.Palette.textPrimary)
                .lineLimit(1)
                .environment(\.layoutDirection, MarkdownText.layoutDirection(for: title))
            HStack(spacing: 6) {
                if !workspace.isEmpty {
                    HStack(spacing: 4) {
                        CoreHubIconView(icon: .folder, size: 12)
                        TechnicalText(text: workspace, font: CoreHubTokens.Typography.font(CoreHubTokens.Typography.workspaceChip), color: CoreHubTokens.Palette.textMuted)
                    }
                    .foregroundStyle(CoreHubTokens.Palette.textMuted)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(CoreHubTokens.Palette.hover, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.tag))
                } else if !agent.isEmpty {
                    Text(agent).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted)
                }
            }
        }
        .frame(maxWidth: 240)
    }
}

// MARK: - Voice input (M1; mic button states idle / listening / transcribing / error)

extension ConversationView {
    func voice() async {
        switch voiceState {
        case .listening: stopVoice(); return
        case .transcribing: return
        case .idle, .error: break
        }
        store.errorMessage = nil
        if store.voiceInput == Preferences.voiceInputServer { await startServerVoice(); return }
        guard OnDeviceSpeechRecognizer.isAvailable(localeIdentifier: store.speechLocaleIdentifier) else {
            store.notify(String(localized: "On-device speech is unavailable; using the Core Hub server"))
            await startServerVoice(); return
        }
        await startDeviceVoice()
    }

    private func startDeviceVoice() async {
        voiceBase = input
        do {
            try await speech.start(localeIdentifier: store.speechLocaleIdentifier) { text, isFinal in
                applyDictation(text)
                guard isFinal else { return }
                if let failure = speech.lastError, text.isEmpty {
                    store.errorMessage = failure; voiceState = .error
                } else {
                    voiceState = .idle; voiceReplyPending = !text.isEmpty
                }
                inputFocused = true
            }
            voiceState = .listening
        } catch OnDeviceSpeechRecognizer.Failure.notAuthorized {
            store.notify(String(localized: "Speech permission was not granted; using the Core Hub server"))
            await startServerVoice()
        } catch OnDeviceSpeechRecognizer.Failure.unavailable {
            store.notify(String(localized: "On-device speech is unavailable; using the Core Hub server"))
            await startServerVoice()
        } catch {
            store.errorMessage = error.localizedDescription; voiceState = .error
        }
    }

    /// Server path: check `/api/studio/stt/profile-status` first, then record 16 kHz WAV.
    private func startServerVoice() async {
        do {
            let status = try await store.api.sttProfileStatus(profile: session.profile)
            guard status.configured, !status.activeProvider.isEmpty else {
                store.errorMessage = status.message; voiceState = .error; return
            }
            serverSttProvider = status.activeProvider
            try await recorder.start()
            voiceState = .listening
        } catch {
            store.errorMessage = error.localizedDescription; voiceState = .error
        }
    }

    private func stopVoice() {
        if speech.isListening { speech.stop(); voiceState = .transcribing; return }
        if recorder.isRecording { Task { await finishServerVoice() } }
    }

    private func finishServerVoice() async {
        guard let url = recorder.stop() else { voiceState = .idle; return }
        voiceState = .transcribing
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            let data = try Data(contentsOf: url)
            let result = try await store.api.transcribe(wav: data, provider: serverSttProvider, language: store.speechLanguageHint, profile: session.profile)
            voiceBase = input
            applyDictation(result.text)
            voiceState = .idle; voiceReplyPending = true; inputFocused = true
        } catch {
            store.errorMessage = error.localizedDescription; voiceState = .error
        }
    }

    /// Replaces the interim dictation segment after `voiceBase`; the final text stays in the field and is never sent automatically.
    private func applyDictation(_ text: String) {
        let base = voiceBase
        guard !text.isEmpty else { input = base; return }
        let separator = base.isEmpty || base.hasSuffix(" ") || base.hasSuffix("\n") ? "" : " "
        input = base + separator + text
    }
}
