import SwiftUI

/// Settings → Voice: the current spoken-reply voice with the way into the
/// picker. The subtitle names the provider that will actually speak.
struct VoiceOutputSettingsRow: View {
    @EnvironmentObject private var store: AppStore
    @ObservedObject private var voice = VoiceOutputStore.shared

    var body: some View {
        NavigationLink {
            VoiceOutputSettingsView()
        } label: {
            SettingsRow(icon: "speaker.wave.3.fill", color: CoreHubTokens.Palette.info,
                        title: "Spoken replies", subtitle: subtitle)
        }
        .task(id: store.selectedProfile) {
            await voice.load(profile: store.selectedProfile, api: store.api)
        }
    }

    private var subtitle: String {
        // `VoiceOutputStore.revision` is published, so a new pick redraws this.
        switch voice.choice(for: store.selectedProfile) {
        case .device: return String(localized: "This iPhone's voice")
        case let .server(provider): return TtsProviderCatalog.label(provider)
        case .serverDefault: return String(localized: "Core Hub server")
        }
    }
}

/// Settings → Voice → Spoken replies.
///
/// Lists the TTS providers Core Hub has for the active profile
/// (`GET /api/studio/tts/settings`), marks the one the server is using, and
/// keeps this iPhone's own voice as an explicit option. The pick is stored
/// per profile on the device; picking a server provider also writes
/// `PUT /api/studio/tts/settings/active` so the web and the phone agree.
/// Nothing is written to the server unless the owner picks a server provider.
struct VoiceOutputSettingsView: View {
    @EnvironmentObject private var store: AppStore
    @ObservedObject private var voice = VoiceOutputStore.shared
    @State private var loading = false
    @State private var saveState: SaveState = .idle

    private var profile: String { store.selectedProfile }
    private var settings: TtsSettings { voice.settings(for: profile) }
    private var choice: VoiceOutputChoice { voice.choice(for: profile) }

    var body: some View {
        Form {
            Section {
                Text("The spoken reply uses the voice provider configured for this profile in Core Hub. This iPhone's voice speaks only when you pick it here, or when the server voice fails.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            serverSection
            deviceSection
            if case let .failed(message) = saveState {
                Section { Text(message).font(.subheadline).foregroundStyle(CoreHubTokens.Palette.error) }
            }
        }
        .navigationTitle("Spoken replies")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: profile) { await load(force: false) }
        .refreshable { await load(force: true) }
    }

    // MARK: - Sections

    @ViewBuilder private var serverSection: some View {
        Section {
            if loading && !voice.isLoaded(profile) {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Loading…").foregroundStyle(.secondary) }
            } else if settings.selectableProviders.isEmpty {
                Text("No voice provider is configured for this profile. Add one under Studio → Voice.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            ForEach(settings.selectableProviders, id: \.self) { provider in
                providerRow(provider)
            }
        } header: {
            Text("Core Hub server")
        } footer: {
            if let error = voice.loadError(for: profile) {
                Text(error).foregroundStyle(CoreHubTokens.Palette.error)
            } else {
                Text("Written to the profile: \(profile)")
            }
        }
    }

    private var deviceSection: some View {
        Section {
            row(title: Text("This iPhone's voice"),
                detail: String(localized: "The built-in iOS voice. Nothing is sent to Core Hub."),
                selected: choice == .device,
                badge: nil) {
                Task { await select(.device) }
            }
        } header: {
            Text("This device")
        }
    }

    private func providerRow(_ provider: String) -> some View {
        let setting = settings.setting(for: provider)
        let isServerActive = settings.activeProvider == provider
        return row(title: TechnicalText(text: TtsProviderCatalog.label(provider),
                                        font: .body.weight(.medium),
                                        color: CoreHubTokens.Palette.textPrimary),
                   detail: setting?.detail ?? "",
                   selected: choice == .server(provider),
                   badge: isServerActive ? String(localized: "Active on the server") : nil) {
            Task { await select(.server(provider)) }
        }
    }

    private func row<Title: View>(title: Title, detail: String, selected: Bool, badge: String?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? CoreHubTokens.Palette.accent : CoreHubTokens.Palette.textMuted)
                VStack(alignment: .leading, spacing: 3) {
                    title
                    if !detail.isEmpty {
                        Text(detail).font(.caption).foregroundStyle(.secondary)
                    }
                    if let badge {
                        Text(badge).font(.caption2).foregroundStyle(CoreHubTokens.Palette.success)
                    }
                }
                Spacer(minLength: 8)
                if saveState.isSaving { ProgressView().controlSize(.small) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(saveState.isSaving)
        .accessibilityAddTraits(selected ? AccessibilityTraits.isSelected : [])
    }

    // MARK: - Actions

    private func load(force: Bool) async {
        loading = true
        await voice.load(profile: profile, api: store.api, force: force)
        loading = false
    }

    private func select(_ next: VoiceOutputChoice) async {
        guard next != choice else { return }
        saveState = .saving
        do {
            try await voice.select(next, profile: profile, api: store.api)
            saveState = .saved
        } catch {
            saveState = .failed(error.localizedDescription)
        }
    }
}
