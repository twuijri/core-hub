import SwiftUI

/// Settings → Voice: the dictation language of the active profile with the
/// way into the picker.
struct SpeechInputLanguageRow: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        NavigationLink {
            SpeechInputLanguageView()
        } label: {
            // `store.speechLanguageRevision` is published, so a pick redraws this.
            SettingsRow(icon: "character.bubble.fill", color: CoreHubTokens.Palette.error,
                        title: "Dictation language",
                        subtitle: store.speechLanguageLabel(for: store.selectedProfile))
        }
    }
}

/// Settings → Voice → Dictation language.
///
/// The app language is not the dictation language: this iPhone and this app
/// can be English while the owner speaks Arabic. The default therefore follows
/// the enabled keyboards. The pick is stored per profile on the device
/// (`Preferences.speechLanguage(for:)`) and reaches both transcription paths —
/// the on-device recogniser's locale and the server's optional `language`
/// hint. Nothing is written to the server.
struct SpeechInputLanguageView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        Form {
            Section {
                Text("Dictation stays on this iPhone and follows the languages of your keyboards. Only languages this iPhone can recognise are listed.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            SpeechInputLanguageList(profile: store.selectedProfile)
        }
        .navigationTitle("Dictation language")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The same list shown in Settings and in the mic long-press sheet.
struct SpeechInputLanguageList: View {
    @EnvironmentObject private var store: AppStore
    let profile: String
    /// Called after a pick so the sheet can close; Settings passes nothing.
    var onPick: (() -> Void)?

    private var choice: SpeechInputChoice { store.speechChoice(for: profile) }
    private var recents: [String] { store.recentSpeechLocales(for: profile) }

    var body: some View {
        Group {
            followSection
            if !recents.isEmpty { recentSection }
            allLanguagesSection
            serverSection
        }
    }

    // MARK: - Sections

    private var followSection: some View {
        Section {
            pickRow(title: Text("Follow my keyboard languages"),
                    detail: String(format: String(localized: "Dictate in %@. Add a keyboard in iOS Settings to change this."),
                                   SpeechLocaleCatalog.endonym(for: store.keyboardSpeechLocaleIdentifier)),
                    selected: choice == .keyboards) { pick(.keyboards) }
            pickRow(title: Text("Follow the app language"),
                    detail: String(format: String(localized: "Dictate in %@."),
                                   SpeechLocaleCatalog.endonym(for: store.speechLocaleIdentifier)),
                    selected: choice == .appLanguage) { pick(.appLanguage) }
        } header: {
            Text("Choose for me")
        }
    }

    private var recentSection: some View {
        Section {
            ForEach(recents, id: \.self) { identifier in
                localeRow(SpeechLocaleOption(identifier: identifier,
                                             endonym: SpeechLocaleCatalog.endonym(for: identifier)))
            }
        } header: {
            Text("Recent")
        }
    }

    private var allLanguagesSection: some View {
        Section {
            if DeviceSpeechLocales.options.isEmpty {
                Text("This iPhone reports no speech recognition languages.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            ForEach(DeviceSpeechLocales.options) { option in
                localeRow(option)
            }
        } header: {
            Text("Languages this iPhone can recognise")
        } footer: {
            Text("Stored on this iPhone for the profile: \(profile)")
        }
    }

    private var serverSection: some View {
        Section {
            pickRow(title: Text("Let the Core Hub server detect it"),
                    detail: String(localized: "Apple's recogniser listens for one language at a time and cannot detect across languages. Only this choice sends the recording to your Core Hub server, which detects the language itself. It needs a speech provider configured for this profile."),
                    selected: choice == .serverDetected) { pick(.serverDetected) }
        } header: {
            Text("Detection across languages")
        }
    }

    // MARK: - Rows

    private func localeRow(_ option: SpeechLocaleOption) -> some View {
        pickRow(title: Text(option.endonym)
            .environment(\.layoutDirection, MarkdownText.layoutDirection(for: option.endonym)),
                detail: "",
                trailing: option.identifier,
                selected: choice == .locale(option.identifier)) {
            pick(.locale(option.identifier))
        }
    }

    private func pick(_ choice: SpeechInputChoice) {
        store.setSpeechChoice(choice, profile: profile)
        onPick?()
    }

    private func pickRow<Title: View>(title: Title, detail: String, trailing: String = "",
                                      selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    title.font(.body.weight(.medium)).foregroundStyle(CoreHubTokens.Palette.textPrimary)
                    if !detail.isEmpty {
                        Text(detail).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if !trailing.isEmpty { TechnicalText(text: trailing) }
                Image(systemName: "checkmark")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(CoreHubTokens.Palette.accent)
                    .opacity(selected ? 1 : 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
    }
}

/// The mic long-press sheet: the same list, so one Arabic dictation never
/// needs a trip through Settings.
struct SpeechInputLanguageSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let profile: String

    var body: some View {
        NavigationStack {
            Form {
                SpeechInputLanguageList(profile: profile) { dismiss() }
            }
            .navigationTitle("Dictation language")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
