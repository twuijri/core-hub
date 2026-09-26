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
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var draft = ""
    @State private var tray: AttachmentTray?
    /// The latest message is on screen (the list's bottom marker is laid out).
    @State private var atBottom = true
    /// The keyboard started opening while the reader was at the latest message.
    @State private var keepBottom = false
    /// The transcript the hub exported, waiting in the share sheet.
    @State private var exported: SharedFile?

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
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        Task { if let url = await model.exportMarkdown() { exported = SharedFile(url: url) } }
                    } label: {
                        Label(l10n("chat.export"), systemImage: "square.and.arrow.up")
                    }
                    .accessibilityIdentifier("chat.export")
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel(l10n("chat.more"))
                .accessibilityIdentifier("chat.more")
            }
        }
        .sheet(item: $exported) { file in ActivitySheet(items: [file.url]) }
        .onAppear {
            if tray == nil { tray = AttachmentTray(app: app) }
            model.start()
            LocalNotices.shared.openSessionID = model.sessionID
        }
        .onDisappear {
            model.stop()
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
                    let visible = model.state.messages.filter { !$0.isEmpty }
                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, message in
                        MessageRow(
                            message: message,
                            startsTurn: Turns.startsTurn(visible, at: index),
                            run: message.runId.flatMap { model.state.runs[$0] },
                            profile: model.profile,
                            agent: message.role == .assistant ? identity(of: message) : nil
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
            Composer(
                text: $draft,
                placeholder: l10n("chat.placeholder", ["agent": agentName]),
                busy: model.state.isBusy,
                sending: model.sending,
                onSend: {
                    let message = tray?.message(draft) ?? OutgoingMessage(text: draft)
                    draft = ""
                    tray?.clear()
                    Task { await model.send(message) }
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
    /// In a room, whether the message is yours: another person is on the left, named, like the
    /// agents (DECISIONS §69). `nil` in a chat, where every person's message is yours.
    var mine: Bool? = nil
    /// Who the agent is (its registry name and face); `nil` draws the author's name and initial.
    var agent: AgentIdentity? = nil
    @Environment(\.l10n) private var l10n
    @Environment(\.layoutDirection) private var uiDirection

    private var isPerson: Bool { mine ?? (message.role == .user || message.role == .command) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            if startsTurn { header }
            if isPerson { personBubble } else { agentCard }
        }
        .padding(.top, startsTurn ? Layout.turnGap : Layout.groupGap)
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
        }
        .accessibilityIdentifier("message.user")
    }

    private var personText: some View {
        HStack {
            Text(message.text)
                .font(.system(size: FontSize.sizeMd))
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
            if let reasoning = message.reasoning, !reasoning.text.isEmpty {
                ReasoningView(reasoning: reasoning, streaming: message.status == .streaming)
            }
            ForEach(message.toolCalls, id: \.id) { call in
                ToolCallCard(call: call)
            }
            if !message.text.isEmpty {
                MarkdownView(text: message.text)
            }
            MessageAttachments(content: message.content, profile: profile)
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
        .padding(Space.s3)
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

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            Text(reasoning.text)
                .font(.system(size: FontSize.sizeSm))
                .foregroundStyle(Tone.textMuted)
                .textSelection(.enabled)
                .contentDirection(of: reasoning.text)
        } label: {
            Text(label)
                .font(.system(size: FontSize.sizeSm))
                .foregroundStyle(Tone.textMuted)
        }
        .tint(Tone.textMuted)
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
