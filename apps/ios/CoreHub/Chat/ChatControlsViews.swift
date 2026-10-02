// The chat controls' views (apps batch 1): compact chips over the composer (a new chat's folder,
// the model, the approvals, and Steer while a reply runs), their sheets, the rename alert, and a
// message's actions. The rules and calls are in ChatControls.swift.
import CoreHubClient
import SwiftUI
import UIKit

/// The row of small chips just above the composer. Each opens a sheet: a phone has no room for
/// the web's popovers, and a sheet has room for what each choice means.
struct ComposerChips: View {
    let controls: ChatControlsModel
    let profile: String
    let agentID: String?
    /// The chat's model (`<provider>/<model>`), `nil` for the agent's default.
    let model: String?
    let onModel: (String?) -> Void
    /// The picker offers «Default model» (a chat goes back to it with `model: null`, §114).
    var allowDefault = false
    /// A new chat's working folder; `nil` hides the chip (a chat's folder is fixed once it ran).
    var folder: Binding<String?>? = nil
    /// Shown while a reply runs and the agent can be steered; `steerReady` once words are typed.
    var onSteer: (() -> Void)? = nil
    var steerReady = false
    @Environment(\.l10n) private var l10n
    @State private var sheet: Sheet?

    enum Sheet: String, Identifiable {
        case model, approvals, folder
        var id: String { rawValue }
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.s2) {
                if let folder {
                    chip(
                        icon: .folder,
                        text: ChatControls.folderName(folder.wrappedValue, root: controls.dirs?.root) ?? l10n("chat_controls.folder_automatic"),
                        label: l10n("chat_controls.folder"), id: "composer.folder"
                    ) { sheet = .folder }
                }
                chip(
                    icon: .cpu,
                    text: ChatControls.modelLabel(model, controls.models) ?? defaultLabel,
                    label: l10n("chat_controls.model"), id: "composer.model"
                ) { sheet = .model }
                if case .ready(let field) = controls.approval {
                    chip(
                        icon: ChatControls.risky(field.value) ? .triangleAlert : .shieldCheck,
                        text: ApprovalSheet.title(field.value, field.options, l10n),
                        label: l10n("chat_controls.approval"), id: "composer.approvals",
                        warning: ChatControls.risky(field.value)
                    ) { sheet = .approvals }
                }
                if let onSteer {
                    chip(
                        icon: .cornerDownRight, text: l10n("chat_controls.steer"),
                        label: l10n("chat_controls.steer_hint"), id: "composer.steer", chevron: false, accent: steerReady
                    ) { onSteer() }
                    .disabled(!steerReady)
                }
            }
            .padding(.horizontal, Space.s1)
        }
        .scrollClipDisabled()
        .sheet(item: $sheet) { which in
            switch which {
            case .model:
                ModelPickerSheet(
                    options: controls.models, loaded: controls.modelsLoaded, current: model, allowDefault: allowDefault,
                    defaultLabel: defaultLabel, choose: onModel
                )
            case .approvals:
                if case .ready(let field) = controls.approval, let agentID {
                    ApprovalSheet(field: field) { value in
                        Task { await controls.setApproval(value, profile: profile, agentID: agentID) }
                    }
                    .presentationDetents([.medium, .large])
                }
            case .folder:
                if let folder {
                    WorkingDirSheet(dirs: controls.dirs, error: controls.dirsError, current: folder.wrappedValue) { folder.wrappedValue = $0 }
                }
            }
        }
    }

    /// «Default · <model>» when the hub says which model that is, else «Default model».
    private var defaultLabel: String {
        controls.defaultModelName.map { l10n("chat_controls.model_default_named", ["model": $0]) }
            ?? l10n("chat_controls.model_default")
    }

    private func chip(
        icon: Lucide, text: String, label: String, id: String,
        chevron: Bool = true, warning: Bool = false, accent: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: Space.s1) {
                LucideIcon(icon, size: 13)
                    .foregroundStyle(warning ? Tone.warningSoftText : (accent ? Tone.accentSoftText : Tone.textMuted))
                Text(text)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 160, alignment: .leading)
                if chevron { LucideIcon(.chevronDown, size: 10).foregroundStyle(Tone.textFaint) }
            }
            .font(.system(size: FontSize.sizeXs, weight: .medium))
            .foregroundStyle(accent ? Tone.accentSoftText : Tone.text)
            .padding(.horizontal, Space.s2)
            .frame(height: Control.heightSm)
            .background(accent ? Tone.accentSoft : Tone.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(accent ? Tone.accent : Tone.border))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(text)
        .accessibilityIdentifier(id)
    }
}

/// The profile's chat models, searchable and grouped by provider.
struct ModelPickerSheet: View {
    let options: [ChatControls.ModelOption]
    let loaded: Bool
    let current: String?
    let allowDefault: Bool
    /// The «Default» row's words (which model it is, when known).
    var defaultLabel: String? = nil
    let choose: (String?) -> Void
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        let shown = ChatControls.filter(options, query)
        NavigationStack {
            List {
                if allowDefault && query.isEmpty {
                    row(value: nil, label: defaultLabel ?? l10n("chat_controls.model_default"), detail: l10n("chat_controls.model_default_hint"))
                }
                if !loaded {
                    ProgressView().frame(maxWidth: .infinity)
                } else if options.isEmpty {
                    Text(l10n("chat_controls.model_none")).foregroundStyle(Tone.textMuted)
                } else if shown.isEmpty {
                    Text(l10n("chat_controls.model_no_match")).foregroundStyle(Tone.textMuted)
                }
                ForEach(ChatControls.groups(shown), id: \.group) { group in
                    Section(group.group) {
                        ForEach(group.options) { option in
                            row(value: option.value, label: option.label, detail: detail(option))
                        }
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: l10n("chat_controls.model_search"))
            .navigationTitle(l10n("chat_controls.model_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(l10n("common.close")) { dismiss() } }
            }
        }
        .accessibilityIdentifier("sheet.model")
    }

    /// The id under the name, and «small context» for a model under the agent's floor (§141).
    private func detail(_ option: ChatControls.ModelOption) -> String? {
        let id = option.label == option.value ? nil : option.value
        guard let floor = option.smallUnder else { return id }
        let small = l10n("chat_controls.model_small_context", ["tokens": String(floor / 1000)])
        return [id, small].compactMap { $0 }.joined(separator: " · ")
    }

    private func row(value: String?, label: String, detail: String?) -> some View {
        Button {
            choose(value)
            dismiss()
        } label: {
            HStack(spacing: Space.s2) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).foregroundStyle(Tone.text)
                    if let detail {
                        Text(detail).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if value == current { LucideIcon(.check, size: 16).foregroundStyle(Tone.accent) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(value == current ? .isSelected : [])
    }
}

/// The agent's approval modes, each with what it changes (owner, 2026-09-22: the difference must
/// be said). Only an admin changes it; it applies to every chat with the agent in this profile.
struct ApprovalSheet: View {
    let field: ChatControls.ApprovalField
    let choose: (String) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss

    /// Our words for the modes we know, the adapter's own label for any other.
    static func title(_ value: String, _ options: [Choice], _ l10n: L10n) -> String {
        let key = "chat_controls.approval_mode.\(value)"
        if l10n.has(key) { return l10n(key) }
        guard let option = options.first(where: { $0.value == value }) else { return value }
        if let labels = option.labels { return l10n.language == .ar ? labels.ar : labels.en }
        return option.label
    }

    static func hint(_ value: String, _ l10n: L10n) -> String? {
        let key = "chat_controls.approval_hint.\(value)"
        return l10n.has(key) ? l10n(key) : nil
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(field.options, id: \.value) { option in
                        Button {
                            choose(option.value)
                            dismiss()
                        } label: {
                            HStack(alignment: .top, spacing: Space.s2) {
                                if ChatControls.risky(option.value) {
                                    LucideIcon(.triangleAlert, size: 14).foregroundStyle(Tone.warningSoftText).padding(.top, 2)
                                }
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(Self.title(option.value, field.options, l10n)).foregroundStyle(Tone.text)
                                    if let hint = Self.hint(option.value, l10n) {
                                        Text(hint).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                                    }
                                }
                                Spacer(minLength: 0)
                                if option.value == field.value { LucideIcon(.check, size: 16).foregroundStyle(Tone.accent) }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!app.isAdmin)
                        .accessibilityAddTraits(option.value == field.value ? .isSelected : [])
                    }
                } footer: {
                    Text(app.isAdmin ? l10n("chat_controls.approval_applies") : l10n("chat_controls.approval_admin"))
                }
            }
            .navigationTitle(l10n("chat_controls.approval"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(l10n("common.close")) { dismiss() } }
            }
        }
        .accessibilityIdentifier("sheet.approvals")
    }
}

/// A new chat's working folder: automatic, one that exists under the hub's root, or a new name.
struct WorkingDirSheet: View {
    let dirs: WorkingDirs?
    let error: String?
    let current: String?
    let choose: (String?) -> Void
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    row(value: nil, title: l10n("chat_controls.folder_automatic"), note: l10n("chat_controls.folder_automatic_note"))
                    ForEach(dirs?.items ?? [], id: \.path) { item in
                        row(value: item.path, title: ChatControls.isGenerated(item.name) ? l10n("chat_controls.folder_automatic") : item.name, note: nil)
                    }
                    if dirs == nil && error == nil { ProgressView().frame(maxWidth: .infinity) }
                } header: {
                    if let root = dirs?.root {
                        Text(root).font(.system(size: FontSize.sizeXs, design: .monospaced)).textCase(nil)
                            .environment(\.layoutDirection, .leftToRight)
                    }
                } footer: {
                    if let error { Text(error).foregroundStyle(Tone.dangerSoftText) } else { Text(l10n("chat_controls.folder_hint")) }
                }
                Section(l10n("chat_controls.folder_new")) {
                    TextField(l10n("chat_controls.folder_new_placeholder"), text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .environment(\.layoutDirection, .leftToRight)
                        .accessibilityIdentifier("folder.new")
                    if !name.isEmpty && ChatControls.newFolder(name) == nil {
                        Text(l10n("chat_controls.folder_bad_name")).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.dangerSoftText)
                    }
                    Button(l10n("chat_controls.folder_use")) {
                        guard let folder = ChatControls.newFolder(name) else { return }
                        choose(folder)
                        dismiss()
                    }
                    .disabled(ChatControls.newFolder(name) == nil)
                }
            }
            .navigationTitle(l10n("chat_controls.folder"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(l10n("common.close")) { dismiss() } }
            }
        }
        .accessibilityIdentifier("sheet.folder")
    }

    private func row(value: String?, title: String, note: String?) -> some View {
        Button {
            choose(value)
            dismiss()
        } label: {
            HStack(spacing: Space.s2) {
                LucideIcon(.folder, size: 16).foregroundStyle(Tone.textMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(Tone.text)
                    if let note { Text(note).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted) }
                }
                Spacer(minLength: 0)
                if value == current { LucideIcon(.check, size: 16).foregroundStyle(Tone.accent) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A chat about to be renamed: the alert starts from its title.
struct RenameTarget: Identifiable, Equatable {
    let id: String
    let profile: String
    let title: String
}

extension View {
    /// «Chat name» with the title in a field, Cancel and Save; an empty name does not save.
    func renameChat(_ target: Binding<RenameTarget?>, save: @escaping (RenameTarget, String) async -> Void) -> some View {
        modifier(RenameAlert(target: target, save: save))
    }
}

private struct RenameAlert: ViewModifier {
    @Binding var target: RenameTarget?
    let save: (RenameTarget, String) async -> Void
    @Environment(\.l10n) private var l10n
    @State private var typed = ""

    func body(content: Content) -> some View {
        content
            .onChange(of: target) { _, next in typed = next?.title ?? "" }
            .alert(l10n("chat_controls.rename_title"), isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } })) {
                TextField(l10n("chat_controls.rename_title"), text: $typed)
                    .accessibilityIdentifier("rename.field")
                Button(l10n("common.cancel"), role: .cancel) { target = nil }
                Button(l10n("chat_controls.save")) {
                    guard let current = target else { return }
                    let text = typed
                    target = nil
                    Task { await save(current, text) }
                }
                .disabled(ChatControls.renameTitle(typed) == nil)
                .accessibilityIdentifier("rename.save")
            }
    }
}

/// What one message offers in a chat (not in a room): copy, read aloud, reply, fork from here.
struct MessageActions {
    var speak: ((Message) -> Void)?
    var reply: ((Message) -> Void)?
    var fork: ((Message) -> Void)?

    static func copy(_ message: Message) {
        UIPasteboard.general.string = message.text
    }
}

/// Under an agent's reply: Copy, and «…» for the rest — quiet, so a long transcript reads as text.
struct MessageActionsRow: View {
    let message: Message
    let actions: MessageActions
    @Environment(\.l10n) private var l10n
    @State private var copied = false

    var body: some View {
        HStack(spacing: Space.s1) {
            Spacer(minLength: 0)
            Button {
                MessageActions.copy(message)
                copied = true
                Task {
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    copied = false
                }
            } label: {
                LucideIcon(copied ? .check : .copy, size: 14).foregroundStyle(Tone.textFaint).tapTarget(32)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(l10n(copied ? "chat_controls.copied" : "chat_controls.copy"))
            .accessibilityIdentifier("message.copy")
            Menu {
                MessageActionsMenu(message: message, actions: actions, copy: false)
            } label: {
                LucideIcon(.ellipsis, size: 14).foregroundStyle(Tone.textFaint).tapTarget(32)
            }
            .accessibilityLabel(l10n("chat_controls.message_actions"))
            .accessibilityIdentifier("message.more")
        }
    }
}

/// The items of a message's menu (a long press on your message, «…» under a reply).
struct MessageActionsMenu: View {
    let message: Message
    let actions: MessageActions
    var copy = true
    @Environment(\.l10n) private var l10n

    var body: some View {
        if copy {
            Button { MessageActions.copy(message) } label: {
                Label { Text(l10n("chat_controls.copy")) } icon: { Image(lucide: .copy) }
            }
        }
        if let speak = actions.speak, message.role == .assistant {
            Button { speak(message) } label: {
                Label { Text(l10n("chat_controls.speak")) } icon: { Image(lucide: .volume2) }
            }
        }
        if let reply = actions.reply {
            Button { reply(message) } label: {
                Label { Text(l10n("chat_controls.reply")) } icon: { Image(lucide: .reply) }
            }
        }
        if let fork = actions.fork {
            Button { fork(message) } label: {
                Label { Text(l10n("chat_controls.fork_here")) } icon: { Image(lucide: .gitFork) }
            }
        }
    }
}

/// A long press on a message: its menu, in a chat only (a room keeps plain selection). An
/// agent's reply can be long, so it shows its opening lines as the preview, not the whole card.
struct MessageMenu: ViewModifier {
    let message: Message
    let actions: MessageActions?
    var preview = false

    func body(content: Content) -> some View {
        if let actions {
            if preview {
                content.contextMenu {
                    MessageActionsMenu(message: message, actions: actions)
                } preview: {
                    Text(message.text)
                        .font(.system(size: FontSize.sizeMd))
                        .lineLimit(12)
                        .contentDirection(of: message.text, fill: false)
                        .padding(Space.s3)
                        .frame(maxWidth: 340, alignment: .leading)
                        .background(Tone.agentBubble)
                }
            } else {
                content.contextMenu { MessageActionsMenu(message: message, actions: actions) }
            }
        } else {
            content
        }
    }
}

/// Over the composer while replying: the words replied to, and a cross that drops the reply.
struct ReplyStrip: View {
    let message: Message
    let cancel: () -> Void
    @Environment(\.l10n) private var l10n

    var body: some View {
        HStack(spacing: Space.s2) {
            LucideIcon(.reply, size: 14).foregroundStyle(Tone.accent)
            Text(l10n("chat_controls.replying_to", ["text": String(message.text.prefix(80))]))
                .font(.system(size: FontSize.sizeXs))
                .foregroundStyle(Tone.textMuted)
                .lineLimit(1)
            Spacer(minLength: 0)
            Button(action: cancel) { LucideIcon(.x, size: 14).foregroundStyle(Tone.textMuted).tapTarget(32) }
                .buttonStyle(.plain)
                .accessibilityLabel(l10n("chat_controls.cancel_reply"))
        }
        .padding(.horizontal, Space.s3)
        .accessibilityIdentifier("composer.reply")
    }
}
