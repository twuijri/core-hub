import SwiftUI

/// Add or edit one agent seat, with the saved presets (`/group-chat/
/// agent-presets`) on top: tap a preset to fill the form, save the current
/// form as a new preset, update the applied one, or delete it.
struct RoomAgentEditorView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let models: [ModelOption]
    let onSave: (RoomAgentInput) -> Void
    @State private var input: RoomAgentInput
    @State private var presets: [GroupAgentPreset] = []
    @State private var presetName = ""
    @State private var presetState: SaveState = .idle

    init(input: RoomAgentInput, models: [ModelOption], onSave: @escaping (RoomAgentInput) -> Void) {
        self.models = models
        self.onSave = onSave
        _input = State(initialValue: input)
    }

    private var globalAllowed: Bool { RoomAgentInput.globalCapable.contains(input.agent) }

    var body: some View {
        NavigationStack {
            Form {
                presetSection
                agentSection
                modelSection
                identitySection
                savePresetSection
            }
            .navigationTitle("Agent seat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { onSave(input); dismiss() }.disabled(!input.isValid)
                }
            }
            .task { await loadPresets() }
        }
    }

    // MARK: Sections

    private var presetSection: some View {
        Section("Presets") {
            if presets.isEmpty { Text("No saved presets").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted) }
            ForEach(presets) { preset in
                Button { input = RoomAgentInput(preset: preset) } label: { presetRow(preset) }
                    .buttonStyle(.plain)
                    .swipeActions {
                        Button(role: .destructive) { Task { await deletePreset(preset) } } label: { Label("Delete", systemImage: "trash") }
                    }
            }
        }
    }

    private func presetRow(_ preset: GroupAgentPreset) -> some View {
        HStack(spacing: 10) {
            AgentAvatarView(asset: AgentAvatarAsset.resolve(runtime: preset.agent, source: preset.agent == "hermes" ? "cli" : "coding_agent"), size: 24)
            VStack(alignment: .leading, spacing: 2) {
                DirectionalText(text: preset.name.nilIfEmpty ?? preset.profile, font: CoreHubTokens.Typography.sessionTitleFont)
                TechnicalText(text: [preset.profile, preset.model].filter { !$0.isEmpty }.joined(separator: " · "))
            }
            Spacer(minLength: 0)
            if input.presetID == preset.id { CoreHubIconView(icon: .check, size: 14).foregroundStyle(CoreHubTokens.Palette.success) }
            if !preset.available { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(CoreHubTokens.Palette.warning) }
        }
        .contentShape(Rectangle())
    }

    private var agentSection: some View {
        Section("Runtime") {
            Picker("Agent", selection: $input.agent) {
                ForEach(RoomAgentInput.agentTypes, id: \.self) { Text($0).tag($0) }
            }
            .onChange(of: input.agent) { _, _ in if !globalAllowed { input.agentMode = "scoped" } }
            Picker("Mode", selection: $input.agentMode) {
                Text("Scoped").tag("scoped")
                if globalAllowed { Text("Global").tag("global") }
            }
            .pickerStyle(.segmented)
            Picker("Profile", selection: $input.profile) {
                Text("Choose a profile").tag("")
                ForEach(store.profiles) { Text($0.name).tag($0.name) }
            }
        }
    }

    private var modelSection: some View {
        Section("Model") {
            Picker("Model", selection: $input.model) {
                Text("Profile default").tag("")
                ForEach(models) { Text($0.name).tag($0.id) }
            }
            .onChange(of: input.model) { _, value in input.provider = models.first { $0.id == value }?.provider ?? "" }
            if input.agent != "hermes" && input.agentMode != "global" {
                Picker("API mode", selection: $input.apiMode) {
                    Text("Default").tag("")
                    Text("Responses").tag("codex_responses")
                    Text("Chat Completions").tag("chat_completions")
                    Text("Anthropic Messages").tag("anthropic_messages")
                }
            }
            Picker("Reasoning effort", selection: $input.reasoningEffort) {
                Text("Default").tag("")
                ForEach(["none", "minimal", "low", "medium", "high", "xhigh", "max"], id: \.self) { Text($0).tag($0) }
            }
        }
    }

    private var identitySection: some View {
        Section {
            TextField("Display name", text: $input.name)
            TextField("Description", text: $input.description, axis: .vertical).lineLimit(1...4)
        } header: { Text("Identity") } footer: {
            Text("The display name is what people type after @ in the room. `all` is reserved.")
        }
    }

    private var savePresetSection: some View {
        Section("Save as preset") {
            TextField("Preset name", text: $presetName)
            SaveButton(title: String(localized: "Save preset"), state: presetState) { Task { await savePreset() } }
                .disabled(!input.isValid)
            if !input.presetID.isEmpty {
                Button("Update the applied preset") { Task { await updatePreset() } }.disabled(!input.isValid)
            }
        }
    }

    // MARK: Presets

    private func loadPresets() async {
        presets = (await store.attempt({ try await store.api.agentPresets(profile: store.selectedProfile) })) ?? []
        if presetName.isEmpty { presetName = input.name }
    }

    private func savePreset() async {
        presetState = .saving
        var body = input
        body.name = presetName.nilIfEmpty ?? input.name
        do {
            let created = try await store.api.createAgentPreset(body)
            presets.append(created)
            input.presetID = created.id
            presetState = .saved
        } catch {
            presetState = .failed(error.localizedDescription)
        }
    }

    private func updatePreset() async {
        presetState = .saving
        var body = input
        body.name = presetName.nilIfEmpty ?? input.name
        do {
            let updated = try await store.api.updateAgentPreset(input.presetID, input: body)
            if let index = presets.firstIndex(where: { $0.id == updated.id }) { presets[index] = updated }
            presetState = .saved
        } catch {
            presetState = .failed(error.localizedDescription)
        }
    }

    private func deletePreset(_ preset: GroupAgentPreset) async {
        guard await store.attempt({ try await store.api.deleteAgentPreset(preset.id) }) != nil else { return }
        presets.removeAll { $0.id == preset.id }
        if input.presetID == preset.id { input.presetID = "" }
    }
}
