// One conversation (destination `chat`). The person is always on the right and the agent always
// on the left, in every locale (DESIGN.md §The conversation): each row fixes its own
// left-to-right frame, and the text inside decides its own direction.
import CoreHubClient
import SwiftUI
import UIKit

struct ChatScreen: View {
    @State var model: ChatModel
    /// A conversation that is a destination of its own (the global agent) keeps that title.
    var fixedTitle: String? = nil
    /// Opens another chat (a fork); `nil` offers no fork.
    var openChat: ((Session) -> Void)? = nil
    /// Leaves this chat once it is archived or deleted (to a new chat).
    var leave: (() -> Void)? = nil
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.openBackground) private var openBackground
    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = ""
    @State private var tray: AttachmentTray?
    /// The latest message is on screen (the list's bottom marker is laid out).
    @State private var atBottom = true
    /// The keyboard started opening while the reader was at the latest message.
    @State private var keepBottom = false
    /// The transcript the hub exported, waiting in the share sheet.
    @State private var exported: SharedFile?
    /// The composer's chips (model, approvals) and the chat's own actions (apps batch 1).
    @State private var controls: ChatControlsModel?
    @State private var replyTo: Message?
    /// `/clear-screen`: the messages shown before it stay in the conversation, hidden here.
    @State private var clearedBefore: String?
    @State private var pickingModel = false
    /// The agent's skills, read the first time `/skill ` is typed.
    @State private var skills: [SlashCommands.SkillChoice]?
    @State private var renaming: RenameTarget?
    @State private var deleting: String?
    /// The chat's insight (apps batch 6): the context ring, runs, subagents, changed files and files.
    @State private var insight: ChatInsightModel?

    var body: some View {
        VStack(spacing: 0) {
            switch model.load {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                VStack(spacing: Space.s3) {
                    NoticeView(text: message, tone: .danger)
                    Button(l10n("common.retry")) { model.reload() }
                }
                .padding(Space.s4)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .ready:
                transcript
            }
            bottom
        }
        .background(Tone.bg)
        .navigationTitle(fixedTitle ?? model.state.title ?? l10n("sessions.untitled"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let insight {
                ToolbarItem(placement: .topBarTrailing) {
                    ChatInsightBar(insight: insight, use: contextUse)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if let insight { ChatInsightMenu(insight: insight) }
                    // What works in the background, in every profile (the top bar shows it only while something runs).
                    if let openBackground {
                        Button {
                            openBackground()
                        } label: {
                            Label { Text(l10n("background.title")) } icon: { Image(lucide: .activity) }
                        }
                        .accessibilityIdentifier("chat.background")
                    }
                    chatMenu
                } label: {
                    LucideIcon(.ellipsis, size: 20)
                }
                .accessibilityLabel(l10n("chat.more"))
                .accessibilityIdentifier("chat.more")
            }
        }
        .renameChat($renaming) { _, title in await model.rename(title) }
        .confirmDelete($deleting, name: { $0 }) { _ in
            try await ChatActions.delete(app, id: model.sessionID, profile: model.profile)
        } deleted: { _ in
            leave?()
        }
        .sheet(item: $exported) { file in ActivitySheet(items: [file.url]) }
        .sheet(isPresented: $pickingModel) {
            ModelPickerSheet(
                options: controls?.models ?? [], loaded: controls?.modelsLoaded ?? false, current: model.state.model, allowDefault: true,
                defaultLabel: controls?.defaultModelName.map { l10n("chat_controls.model_default_named", ["model": $0]) }
            ) { value in
                Task { await model.setModel(value) }
            }
        }
        .sheet(item: Binding(get: { insight?.sheet }, set: { insight?.sheet = $0 })) { which in
            if let insight {
                ChatInsightSheet(
                    which: which, chat: model, insight: insight, use: contextUse,
                    canCompress: agent?.capabilities.contains(.compress) ?? false
                )
            }
        }
        .onAppear {
            if insight == nil { insight = ChatInsightModel(app: app, sessionID: model.sessionID, profile: model.profile) }
            insight?.start()
            if tray == nil { tray = AttachmentTray(app: app) }
            // A profile file the Files page made an attachment of: in the tray, ready.
            if let tray { app.handOff.take(model.profile).forEach { tray.addReady($0) } }
            if controls == nil { controls = ChatControlsModel(app: app) }
            model.start()
            model.setViewing(scenePhase == .active)
            LocalNotices.shared.openSessionID = model.sessionID
        }
        // The app in front or not: no phone push for a reply the person is watching (§149).
        .onChange(of: scenePhase) { _, phase in model.setViewing(phase == .active) }
        .onDisappear {
            model.stop()
            insight?.stop()
            if LocalNotices.shared.openSessionID == model.sessionID { LocalNotices.shared.openSessionID = nil }
        }
        .accessibilityIdentifier("screen.chat")
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if model.state.hasOlder {
                        Button {
                            Task { await model.loadOlder() }
                        } label: {
                            if model.loadingOlder { ProgressView() } else { Text(l10n("sessions.load_more")) }
                        }
                        .font(.system(size: FontSize.sizeSm))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Space.s2)
                    }
                    if model.state.deleted {
                        NoticeView(text: l10n("chat.deleted"), tone: .warning)
                    }
                    if clearedBefore != nil {
                        Button(l10n("slash_commands.show_cleared")) { clearedBefore = nil }
                            .font(.system(size: FontSize.sizeXs))
                            .frame(maxWidth: .infinity)
                            .accessibilityIdentifier("chat.show_cleared")
                    }
                    let visible = SlashCommandRun.afterClear(model.state.messages.filter { !$0.isEmpty }, clearedBefore)
                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, message in
                        MessageRow(
                            message: message,
                            startsTurn: Turns.startsTurn(visible, at: index),
                            run: message.runId.flatMap { model.state.runs[$0] },
                            profile: model.profile,
                            sessionID: model.sessionID,
                            agent: message.role == .assistant ? identity(of: message) : nil,
                            actions: messageActions
                        )
                        .id(message.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, Space.s4)
                .padding(.vertical, Space.s3)
            }
            // Dragging the list pulls the keyboard down with the finger, and a tap on the
            // conversation puts it away (buttons, links and selection inside keep working).
            .scrollDismissesKeyboard(.interactively)
            .dismissesKeyboardOnTap()
            .defaultScrollAnchor(.bottom)
            // The keyboard takes the bottom of the screen: a reader at the latest message stays
            // there, above the composer, instead of the list shrinking over it.
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                keepBottom = atBottom
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                if keepBottom {
                    withAnimation(.easeOut(duration: Motion.fast)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                keepBottom = false
            }
            .onChange(of: model.state.messages.last?.text.count) { _, _ in
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onChange(of: model.state.messages.count) { _, _ in
                withAnimation(.easeOut(duration: Motion.fast)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    private var bottom: some View {
        VStack(spacing: Space.s2) {
            ForEach(model.state.pendingApprovals, id: \.id) { approval in
                ApprovalCard(approval: approval) { decision, answer in
                    Task { await model.respond(approval, decision: decision, answer: answer) }
                }
            }
            if let run = model.state.activeRun {
                ThinkingIndicator(run: run, step: currentStep)
            }
            if let error = model.actionError {
                NoticeView(text: error, tone: .danger)
                    .onTapGesture { model.actionError = nil }
            }
            if let notice = model.notice {
                NoticeView(text: notice, tone: .info)
                    .onTapGesture { model.notice = nil }
                    .accessibilityIdentifier("chat.notice")
            }
            if let failure = controls?.error {
                NoticeView(text: failure, tone: .danger)
                    .onTapGesture { controls?.error = nil }
            }
            if !model.outbox.isEmpty {
                MessageQueueStrip(
                    items: model.outbox,
                    sendNow: { item in Task { await model.release(item, when: .next) } },
                    steer: { item in Task { await model.release(item, when: .interrupt) } },
                    remove: { item in model.removeQueued(item) }
                )
            }
            if let replyTo {
                ReplyStrip(message: replyTo) { self.replyTo = nil }
            }
            if let controls {
                ComposerChips(
                    controls: controls,
                    profile: model.profile,
                    agentID: model.state.agentID,
                    model: model.state.model,
                    onModel: { value in
                        Task { await model.setModel(value) }
                    },
                    allowDefault: true,
                    onSteer: canSteerAtAll ? steer : nil,
                    steerReady: ChatControls.canSteer(running: model.state.isBusy, text: draft, capabilities: agent?.capabilities ?? [])
                )
                .onAppear { controls.load(profile: model.profile, agentID: model.state.agentID) }
                .onChange(of: model.state.agentID) { _, id in controls.load(profile: model.profile, agentID: id) }
            }
            if slashOffered.contains(where: { $0.name == "skill" }), let word = SlashCommands.skillQuery(draft) {
                SkillMenu(skills: SlashCommands.filterSkills(skills ?? [], word), loaded: skills != nil) { skill in
                    draft = "/skill \(skill.key) "
                }
                .task(id: model.state.agentID) { await loadSkills() }
            } else if let query = SlashCommands.query(draft) {
                SlashMenu(commands: SlashCommands.filter(slashOffered, query)) { command in
                    if command.argument == .none {
                        draft = ""
                        runSlash(command, argument: "")
                    } else {
                        draft = "/\(command.name) "
                    }
                }
            }
            Composer(
                text: $draft,
                placeholder: l10n("chat.placeholder", ["agent": agentName]),
                busy: model.state.isBusy,
                sending: model.sending,
                onSend: {
                    // A `/command` this chat offers runs instead of being sent (decision §57).
                    if tray?.isEmpty ?? true, let parsed = SlashCommands.parse(draft, offered: slashOffered), parsed.command.kind != .message {
                        if parsed.command.argument == .required && parsed.argument.isEmpty {
                            model.notice = l10n("slash_commands.needs_argument", ["command": "/" + parsed.command.name])
                            return
                        }
                        draft = ""
                        runSlash(parsed.command, argument: parsed.argument)
                        return
                    }
                    let message = tray?.message(draft) ?? OutgoingMessage(text: draft)
                    let reply = replyTo?.id
                    draft = ""
                    replyTo = nil
                    tray?.clear()
                    Task { await model.send(message, replyTo: reply) }
                },
                onStop: { Task { await model.stopRun() } },
                attachments: tray,
                profile: model.profile,
                recentText: model.state.messages.suffix(8).map(\.text)
            )
        }
        .padding(.horizontal, Space.s3)
        .padding(.bottom, Space.s2)
    }

    /// The `/` commands this chat offers: its agent's, and the app's (not in the global agent's chat).
    private var slashOffered: [SlashCommands.Command] {
        SlashCommands.available(agent?.capabilities ?? []).filter { command in
            switch command.name {
            case "fork", "new", "archive": return !isGlobalAgent && (command.name != "fork" || openChat != nil)
            default: return true
            }
        }
    }

    private func loadSkills() async {
        guard skills == nil, let agentID = model.state.agentID else { return }
        let profile = model.profile
        let list = try? await app.api.call { try await AgentsAPI.agentsListSkills(xHubProfile: profile, agentId: agentID, apiConfiguration: $0) }
        skills = SlashCommands.skills(list?.categories ?? [])
    }

    private func runSlash(_ command: SlashCommands.Command, argument: String) {
        switch command.name {
        case "compress":
            Task { await model.compress(focus: argument) }
        case "steer":
            Task { await model.steer(argument) }
        case "new":
            leave?()
        case "fork":
            Task { if let session = await model.fork() { openChat?(session) } }
        case "archive":
            Task { if await model.change(SessionPatch(archived: true)) { leave?() } }
        case "model":
            if argument.isEmpty {
                pickingModel = true
            } else if let value = SlashCommands.model(named: argument, in: controls?.models ?? []) {
                Task { await model.setModel(value) }
            } else {
                model.notice = l10n("slash_commands.model_unknown", ["model": argument])
            }
        case "clear-screen":
            clearedBefore = model.state.messages.last?.id
            model.notice = l10n("slash_commands.cleared")
        default:
            break
        }
    }

    /// The chat's agent, for what it can do (steer, compress).
    private var agent: Agent? {
        guard let id = model.state.agentID else { return nil }
        return app.agentDirectory.agents(model.profile).first { $0.id == id } ?? app.agents.first { $0.id == id }
    }

    /// How full the chat's window is, when known: the agent's report, else the catalogue's window for
    /// the chat's model and the last counted turn (ChatInsight.use).
    private var contextUse: ChatInsight.Use? {
        ChatInsight.use(
            reported: model.state.context,
            window: controls?.models.first { $0.value == model.state.model }?.window,
            runs: Array(model.state.runs.values)
        )
    }

    private var isGlobalAgent: Bool { fixedTitle != nil || model.state.source == .globalAgent }

    /// Steer is offered while a reply runs, to an agent that can take it.
    private var canSteerAtAll: Bool {
        model.state.isBusy && (agent?.capabilities.contains(.steer) ?? false)
    }

    private func steer() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        Task { await model.steer(text) }
    }

    /// Copy, read aloud, reply and fork, under each message of this chat.
    private var messageActions: MessageActions {
        let profile = model.profile
        return MessageActions(
            speak: { [app] message in Speaker.shared.speak(message.text, app: app, profile: profile) },
            reply: { message in replyTo = message },
            fork: openChat == nil || isGlobalAgent ? nil : { message in
                Task { if let session = await model.fork(at: message.id) { openChat?(session) } }
            }
        )
    }

    /// The «…» in the top bar: the chat's own actions, in the web's order.
    @ViewBuilder
    private var chatMenu: some View {
        let actions = ChatControls.actions(
            pinned: model.state.pinned,
            archived: model.state.archived,
            globalAgent: isGlobalAgent,
            canCompress: agent?.capabilities.contains(.compress) ?? false,
            titled: !(model.state.title ?? "").isEmpty
        ).filter { $0 != .fork || openChat != nil }
        ForEach(actions, id: \.self) { action in
            switch action {
            case .rename:
                menuItem(action, "chat_controls.rename", .pencil) {
                    renaming = RenameTarget(id: model.sessionID, profile: model.profile, title: model.state.title ?? "")
                }
            case .autoTitle, .pin, .unpin, .archive, .unarchive:
                menuItem(action, action == .autoTitle ? "chat_controls.auto_title" : "chat_controls.\(action.rawValue)", icon(for: action)) {
                    guard let patch = ChatControls.patch(action) else { return }
                    Task {
                        let done = await model.change(patch)
                        if done && action == .archive { leave?() }
                    }
                }
            case .fork:
                menuItem(action, "chat_controls.fork", .gitFork) {
                    Task { if let session = await model.fork() { openChat?(session) } }
                }
            case .compress:
                Button {
                    Task { await model.compress() }
                } label: {
                    Label {
                        Text(l10n("chat_controls.compress"))
                        if model.state.isBusy { Text(l10n("chat_controls.compress_wait")) }
                    } icon: { Image(lucide: .shrink) }
                }
                .disabled(model.state.isBusy || model.compressing)
                .accessibilityIdentifier("chat.compress")
            case .export:
                menuItem(action, "chat.export", .share) {
                    Task { if let url = await model.exportMarkdown() { exported = SharedFile(url: url) } }
                }
            case .delete:
                Divider()
                Button(role: .destructive) {
                    deleting = model.state.title ?? l10n("sessions.untitled")
                } label: {
                    Label { Text(l10n("chat_controls.delete")) } icon: { Image(lucide: .trash) }
                }
                .accessibilityIdentifier("chat.delete")
            }
        }
    }

    private func menuItem(_ action: ChatControls.Action, _ key: String, _ icon: Lucide, run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Label { Text(l10n(key)) } icon: { Image(lucide: icon) }
        }
        .accessibilityIdentifier("chat.\(action.rawValue)")
    }

    private func icon(for action: ChatControls.Action) -> Lucide {
        switch action {
        case .autoTitle: return .sparkles
        case .pin: return .pin
        case .unpin: return .pinOff
        case .archive: return .archive
        case .unarchive: return .archiveRestore
        default: return .ellipsis
        }
    }

    /// A reply's agent: the registry's name and face, never the placeholder «agent».
    private func identity(of message: Message) -> AgentIdentity {
        AgentIdentity.of(
            authorID: message.author.id ?? model.state.agentID,
            shownName: message.author.name,
            agents: app.agentDirectory.agents(model.profile),
            fallback: agentName
        )
    }

    private var agentName: String {
        guard let id = model.state.agentID else { return l10n("chat.agent") }
        return app.agentDirectory.agents(model.profile).first { $0.id == id }?.name
            ?? app.agents.first { $0.id == id }?.name ?? l10n("chat.agent")
    }

    /// The tool the active run is in, when the agent reported one.
    private var currentStep: String? {
        guard let run = model.state.activeRun else { return nil }
        let message = model.state.messages.last { $0.runId == run.id && $0.role == .assistant }
        return message?.toolCalls.last { $0.status == .running }?.name
    }
}

/// Consecutive messages from the same speaker are one turn (DESIGN.md §Grouping): decided from
/// the role and the speaker's name, never from the content.
enum Turns {
    static func speaker(_ message: Message) -> String {
        message.role == .user || message.role == .command ? "user" : "agent:\(message.author.name)"
    }

    static func startsTurn(_ messages: [Message], at index: Int) -> Bool {
        guard index > 0 else { return true }
        return speaker(messages[index - 1]) != speaker(messages[index])
    }
}

struct MessageRow: View {
    let message: Message
    let startsTurn: Bool
    let run: Run?
    /// The chat's profile: the one its files are fetched from.
    var profile: String = ""
    /// The conversation, for links in a reply to its working folder's files; nil in a room.
    var sessionID: String? = nil
    /// In a room, whether the message is yours: another person is on the left, named, like the
    /// agents (DECISIONS §69). `nil` in a chat, where every person's message is yours.
    var mine: Bool? = nil
    /// Who the agent is (its registry name and face); `nil` draws the author's name and initial.
    var agent: AgentIdentity? = nil
    /// What the message offers in a chat (copy, read aloud, reply, fork); `nil` in a room.
    var actions: MessageActions? = nil
    @Environment(\.l10n) private var l10n
    @Environment(\.layoutDirection) private var uiDirection
    /// Settings → Display: reasoning and tool steps shown or not, compact, the text size.
    @Environment(\.chatLook) private var look

    private var isPerson: Bool { mine ?? (message.role == .user || message.role == .command) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            if startsTurn { header }
            if isPerson { personBubble } else { agentCard }
        }
        .padding(.top, look.gap(startsTurn: startsTurn))
        // The side says who is speaking, and does not turn with the language.
        .environment(\.layoutDirection, .leftToRight)
    }

    private var header: some View {
        HStack(spacing: Space.s2) {
            if isPerson { Spacer(minLength: 0) }
            if !isPerson {
                if let agent {
                    AgentAvatar(identity: agent, profile: profile, size: Layout.avatarSm)
                } else {
                    Circle()
                        .fill(Tone.accentSoft)
                        .frame(width: Layout.avatarSm, height: Layout.avatarSm)
                        .overlay(
                            Text(String(message.author.name.prefix(1)).uppercased())
                                .font(.system(size: FontSize.sizeXs, weight: .bold))
                                .foregroundStyle(Tone.accentSoftText)
                        )
                }
            }
            Text(isPerson ? l10n("chat.you") : (agent?.name ?? message.author.name))
                .font(.system(size: FontSize.sizeSm, weight: .semibold))
                .foregroundStyle(Tone.textMuted)
                .environment(\.layoutDirection, uiDirection)
        }
    }

    private var personBubble: some View {
        HStack {
            Spacer(minLength: Space.s12)
            VStack(alignment: .trailing, spacing: Space.s1) {
                if !message.text.isEmpty { personText }
                MessageAttachments(content: message.content, profile: profile)
            }
            .modifier(MessageMenu(message: message, actions: message.text.isEmpty ? nil : actions))
        }
        .accessibilityIdentifier("message.user")
    }

    private var personText: some View {
        HStack {
            Text(message.text)
                .font(.system(size: look.size(FontSize.sizeMd)))
                .foregroundStyle(Tone.userBubbleText)
                .textSelection(.enabled)
                .contentDirection(of: message.text, fill: false)
                .padding(.horizontal, Space.s3)
                .padding(.vertical, Space.s2)
                .background(Tone.userBubble, in: BubbleShape(tightCorner: .topTrailing))
                .overlay(BubbleShape(tightCorner: .topTrailing).stroke(Tone.userBubbleBorder, lineWidth: 1))
        }
    }

    private var agentCard: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            if look.showReasoning, let reasoning = message.reasoning, !reasoning.text.isEmpty {
                ReasoningView(reasoning: reasoning, streaming: message.status == .streaming)
            }
            if look.showToolCalls, !message.toolCalls.isEmpty {
                ToolActivityView(calls: message.toolCalls, live: message.status == .streaming)
            }
            if !message.text.isEmpty {
                // A link in the reply that names one of its files opens it (FileLinkOpener).
                MarkdownView(text: message.text)
                    .modifier(FileLinkOpener(own: MessageAttachments.files(message.content), profile: profile, sessionID: sessionID))
            }
            MessageAttachments(content: message.content, profile: profile)
            if let actions, message.status != .streaming, !message.text.isEmpty {
                MessageActionsRow(message: message, actions: actions)
            }
            switch message.status {
            case .failed:
                NoticeView(text: l10n("chat.failed", ["message": run?.error?.error ?? "—"]), tone: .danger)
            case .interrupted:
                Text(l10n("chat.interrupted"))
                    .font(.system(size: FontSize.sizeSm))
                    .foregroundStyle(Tone.textMuted)
            default:
                EmptyView()
            }
        }
        .padding(look.padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tone.agentBubble, in: BubbleShape(tightCorner: .topLeading))
        .overlay(BubbleShape(tightCorner: .topLeading).stroke(Tone.agentBubbleBorder, lineWidth: 1))
        .accessibilityIdentifier("message.agent")
    }
}

/// Rounded, no tail, the corner nearest its own side tightened.
struct BubbleShape: Shape {
    enum Corner { case topLeading, topTrailing }
    let tightCorner: Corner

    func path(in rect: CGRect) -> Path {
        let big = Radius.lg
        let small = Radius.sm
        let radii = RectangleCornerRadii(
            topLeading: tightCorner == .topLeading ? small : big,
            bottomLeading: big,
            bottomTrailing: big,
            topTrailing: tightCorner == .topTrailing ? small : big
        )
        return UnevenRoundedRectangle(cornerRadii: radii, style: .continuous).path(in: rect)
    }
}

/// History, not the reply: one quiet line, the reasoning behind a closed disclosure.
struct ReasoningView: View {
    let reasoning: Reasoning
    let streaming: Bool
    @Environment(\.l10n) private var l10n
    @State private var open = false

    // One quiet line with a small chevron after it, as on the web — the reasoning is history,
    // so it must not look like the reply (DESIGN.md §The thinking indicator).
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            Button {
                withAnimation(.easeInOut(duration: Motion.fast)) { open.toggle() }
            } label: {
                HStack(spacing: Space.s1) {
                    Text(label)
                        .font(.system(size: FontSize.sizeSm))
                    LucideIcon(.chevronDown, size: 12)
                        .rotationEffect(.degrees(open ? 180 : 0))
                }
                .foregroundStyle(Tone.textMuted)
                .frame(minHeight: 28)
                .hitSlop(8)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(open ? .isSelected : [])
            if open {
                Text(reasoning.text)
                    .font(.system(size: FontSize.sizeSm))
                    .foregroundStyle(Tone.textMuted)
                    .textSelection(.enabled)
                    .contentDirection(of: reasoning.text)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var label: String {
        if streaming { return l10n("chat.thinking") }
        // A made-up number is worse than none.
        guard let ms = reasoning.durationMs else { return l10n("chat.reasoning") }
        return l10n("chat.thought_for", ["seconds": String(max(1, ms / 1000))])
    }
}

/// Something moving, the word, and the elapsed seconds counting up — never fewer (DESIGN.md
/// §The thinking indicator). Reduced motion stops the dots; the seconds keep counting.
struct ThinkingIndicator: View {
    let run: Run
    let step: String?
    @Environment(\.l10n) private var l10n
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: Space.s2) {
                dots(phase: Int(context.date.timeIntervalSinceReferenceDate * 2))
                Text(line(now: context.date))
                    .font(.system(size: FontSize.sizeSm))
                    .foregroundStyle(Tone.textMuted)
                    .monospacedDigit()
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.s3)
            .padding(.vertical, Space.s2)
        }
        .accessibilityIdentifier("chat.thinking")
    }

    private func line(now: Date) -> String {
        if run.status == .queued, let position = run.queuePosition {
            return l10n("chat.queued", ["position": String(position)])
        }
        let start = run.startedAt ?? run.createdAt
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        var parts = [l10n("chat.thinking"), l10n("tool.duration", ["seconds": String(seconds)])]
        if let step { parts.append(step) }
        return parts.joined(separator: " · ")
    }

    private func dots(phase: Int) -> some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Tone.thinking)
                    .frame(width: 6, height: 6)
                    .opacity(reduceMotion ? 1 : (phase % 3 == index ? 1 : 0.35))
            }
        }
        .accessibilityHidden(true)
    }
}

/// A file handed to the share sheet.
struct SharedFile: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// The system's share sheet.
struct ActivitySheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
