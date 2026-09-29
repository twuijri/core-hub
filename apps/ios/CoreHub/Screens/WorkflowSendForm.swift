// The parts of the workflow editor the web keeps in SendForm.tsx and StepTest.tsx: where a "Send
// message" step's words go (§124) — Telegram, by the profile's own bot, and/or a conversation of
// this hub — which also says where a workflow's failure alert goes (§127); and "Test this step"
// (§127), one step tried on its own with a sample, nothing saved and no run made. Rules:
// WorkflowEditRules.swift.
import CoreHubClient
import SwiftUI

/// Telegram and/or a conversation, as a `WorkflowSend`'s targets. A target of a platform this
/// app does not know is kept as it is.
struct SendTargetsForm: View {
    let send: WorkflowSend
    let profile: String
    var tag = "workflow.send"
    /// Offer Telegram formatting (§137): a step's words; a failure alert is always plain.
    var formatting = false
    let onChange: (WorkflowSend) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var chat: String
    @State private var conversations: [Session]?

    init(send: WorkflowSend, profile: String, tag: String = "workflow.send", formatting: Bool = false, onChange: @escaping (WorkflowSend) -> Void) {
        self.send = send
        self.profile = profile
        self.tag = tag
        self.formatting = formatting
        self.onChange = onChange
        _chat = State(initialValue: WorkflowEditRules.target(send, WorkflowEditRules.telegram)?.chatId ?? "")
    }

    var body: some View {
        let telegram = WorkflowEditRules.target(send, WorkflowEditRules.telegram)
        let conversation = WorkflowEditRules.target(send, WorkflowEditRules.coreHub)
        Toggle(l10n("workflow_editor.send.telegram"), isOn: Binding(
            get: { telegram != nil },
            set: { on in
                onChange(WorkflowEditRules.setTarget(send, platform: WorkflowEditRules.telegram,
                                                     on ? WorkflowEditRules.telegramTarget(chatID: chat, formatting: formatting ? "plain" : nil) : nil))
            }
        ))
        .accessibilityIdentifier("\(tag).telegram")
        if telegram != nil {
            VStack(alignment: .leading, spacing: Space.s1) {
                TextField("-1001234567890", text: Binding(
                    get: { chat },
                    set: { value in
                        chat = value
                        // Everything else the target says (its formatting) stays as it is.
                        onChange(WorkflowEditRules.setTarget(send, platform: WorkflowEditRules.telegram,
                                                             WorkflowEditRules.telegramTarget(chatID: value, formatting: telegram?.formatting)))
                    }
                ))
                .monoField()
                .keyboardType(.numbersAndPunctuation)
                .accessibilityLabel(l10n("workflow_editor.send.chat_id"))
                .accessibilityIdentifier("\(tag).chat")
                Text(l10n("workflow_editor.send.telegram_hint")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                if formatting {
                    let current = WorkflowEditRules.formatting(of: telegram)
                    Text(l10n("workflow_editor.send.formatting")).font(.system(size: FontSize.sizeSm, weight: .medium))
                    Picker(l10n("workflow_editor.send.formatting"), selection: Binding(
                        get: { current },
                        set: { value in onChange(WorkflowEditRules.withFormatting(send, value)) }
                    )) {
                        ForEach(WorkflowEditRules.formattings, id: \.self) { value in
                            Text(l10n("workflow_editor.send.formatting_\(value)")).tag(value)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("\(tag).formatting")
                    Text(l10n("workflow_editor.send.formatting_\(current)_hint")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                }
            }
        }
        Toggle(l10n("workflow_editor.send.conversation"), isOn: Binding(
            get: { conversation != nil },
            set: { on in
                onChange(WorkflowEditRules.setTarget(send, platform: WorkflowEditRules.coreHub, on ? WorkflowEditRules.conversationTarget(nil) : nil))
            }
        ))
        .accessibilityIdentifier("\(tag).conversation")
        if let conversation {
            VStack(alignment: .leading, spacing: Space.s1) {
                Picker(l10n("workflow_editor.send.conversation"), selection: Binding<String?>(
                    get: { conversation.sessionId },
                    set: { id in
                        guard id != conversation.sessionId else { return }
                        let picked = (conversations ?? []).first { $0.id == id }
                        onChange(WorkflowEditRules.setTarget(send, platform: WorkflowEditRules.coreHub, WorkflowEditRules.conversationTarget(picked)))
                    }
                )) {
                    Text(l10n("workflow_editor.send.pick")).tag(String?.none)
                    // The saved one, while the list is not read yet or no longer has it.
                    if let id = conversation.sessionId, !(conversations ?? []).contains(where: { $0.id == id }) {
                        Text(conversation.title ?? l10n("workflow_editor.send.untitled")).tag(String?.some(id))
                    }
                    ForEach(conversations ?? [], id: \.id) { session in
                        Text(title(session)).tag(String?.some(session.id))
                    }
                }
                .accessibilityIdentifier("\(tag).session")
                Text(l10n("workflow_editor.send.conversation_hint")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
            }
            .task { await loadConversations() }
        }
    }

    private func title(_ session: Session) -> String {
        let words = (session.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return words.isEmpty ? l10n("workflow_editor.send.untitled") : words
    }

    /// The profile's conversations (the web reads the same list).
    private func loadConversations() async {
        guard conversations == nil else { return }
        let profile = profile
        let listed = try? await app.api.call {
            try await SessionsAPI.sessionsList(xHubProfile: profile, limit: 200, apiConfiguration: $0)
        }
        conversations = listed?.items ?? []
    }
}

/// "Test this step" (§127), folded until opened: a sample input and event, "Try it", and what the
/// step did — a condition's yes or no, the rendered words, an agent's answer when it really ran.
struct StepTestSection: View {
    /// The step as it is drawn now.
    let node: WorkflowNode
    let profile: String
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var open = false
    @State private var input = ""
    @State private var trigger = WorkflowEditRules.sampleTrigger
    @State private var execute = false
    @State private var badJSON = false
    @State private var testing = false
    @State private var result: WorkflowStepTestResult?
    @State private var error: String?

    var body: some View {
        Section {
            DisclosureGroup(l10n("workflow_editor.test.title"), isExpanded: $open) {
                TextField(l10n("workflow_editor.test.input"), text: $input, axis: .vertical)
                    .lineLimit(1...4)
                    .contentDirection(of: input)
                    .accessibilityIdentifier("workflow.step.test.input")
                VStack(alignment: .leading, spacing: Space.s1) {
                    Text(l10n("workflow_editor.test.trigger")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                    TextEditor(text: $trigger)
                        .monoField()
                        .frame(minHeight: 160)
                        .accessibilityLabel(l10n("workflow_editor.test.trigger"))
                        .accessibilityIdentifier("workflow.step.test.trigger")
                }
                if badJSON { NoticeView(text: l10n("workflow_editor.test.bad_json"), tone: .danger) }
                if node.kind == .agent {
                    Toggle(l10n("workflow_editor.test.execute"), isOn: $execute)
                        .accessibilityIdentifier("workflow.step.test.execute")
                }
                Button {
                    Task { await run() }
                } label: {
                    LucideLabel(l10n("workflow_editor.test.run"), icon: .play, size: 16)
                }
                .disabled(testing)
                .accessibilityIdentifier("workflow.step.test.run")
                if let error { NoticeView(text: error, tone: .danger) }
                if let result { outcome(result) }
            }
            .accessibilityIdentifier("workflow.step.test")
        }
    }

    @ViewBuilder
    private func outcome(_ result: WorkflowStepTestResult) -> some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            if let answer = result.answer {
                Text(l10n(answer ? "workflow_editor.test.yes" : "workflow_editor.test.no"))
                    .font(.system(size: FontSize.sizeSm, weight: .medium))
                    .accessibilityIdentifier("workflow.step.test.answer")
            }
            if let rendered = result.rendered {
                block(rendered).accessibilityIdentifier("workflow.step.test.rendered")
            }
            if result.executed, node.kind == .agent, let output = result.output {
                block(output).accessibilityIdentifier("workflow.step.test.output")
            }
            if let failure = result.error, !failure.isEmpty {
                Text(failure).font(.system(size: FontSize.sizeSm)).foregroundStyle(Tone.danger).contentDirection(of: failure)
            }
        }
    }

    private func block(_ text: String) -> some View {
        Text(text)
            .font(.system(size: FontSize.sizeSm))
            .textSelection(.enabled)
            .contentDirection(of: text)
            .padding(Space.s2)
            .background(Tone.surface2, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
    }

    private func run() async {
        switch WorkflowEditRules.stepTest(node: node, input: input, trigger: trigger, execute: execute) {
        case .failure:
            badJSON = true
        case .success(let body):
            badJSON = false
            testing = true
            defer { testing = false }
            let profile = profile
            do {
                result = try await app.api.call {
                    try await SchedulesAPI.schedulesTestWorkflowStep(xHubProfile: profile, workflowStepTest: body, apiConfiguration: $0)
                }
                error = nil
            } catch {
                result = nil
                self.error = HubFailure(error).describe(l10n)
            }
        }
    }
}
