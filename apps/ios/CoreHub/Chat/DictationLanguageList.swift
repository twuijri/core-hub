// Every language dictation can listen in, searchable: «More languages…» in the microphone's
// menu and «Dictation language» in This device. Auto — the keyboard in use picks — comes first;
// then the keyboards' and popular languages; then all the phone's recognizer knows.
import Speech
import SwiftUI

struct DictationLanguageList: View {
    @Binding var choice: String
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var reader: String { app.language.rawValue }

    /// The recognizer's locales, once each, by name in the reader's language.
    private var all: [String] {
        var seen = Set<String>()
        return SFSpeechRecognizer.supportedLocales()
            .compactMap { DictationLanguage.tag($0.identifier) }
            .filter { seen.insert($0.lowercased()).inserted }
            .sorted { DictationLanguage.name($0, in: reader).localizedCompare(DictationLanguage.name($1, in: reader)) == .orderedAscending }
    }

    private var suggested: [String] {
        DictationLanguage.menu(
            keyboards: KeyboardLanguage.enabled,
            supported: SFSpeechRecognizer.supportedLocales().map(\.identifier)
        )
    }

    private var found: [String] {
        let words = query.trimmingCharacters(in: .whitespaces)
        guard !words.isEmpty else { return all }
        return all.filter {
            DictationLanguage.name($0, in: reader).localizedCaseInsensitiveContains(words)
                || DictationLanguage.name($0, in: "en").localizedCaseInsensitiveContains(words)
                || $0.localizedCaseInsensitiveContains(words)
        }
    }

    var body: some View {
        List {
            if query.isEmpty {
                Section {
                    row(DictationLanguage.auto, title: l10n("voice.language_auto"))
                } footer: {
                    Text(l10n("voice.language_auto_hint"))
                }
                Section(l10n("voice.language_suggested")) {
                    ForEach(suggested, id: \.self) { row($0) }
                }
            }
            Section(l10n("voice.language_all")) {
                ForEach(found, id: \.self) { row($0) }
            }
        }
        .searchable(text: $query, prompt: l10n("nav.search"))
        .navigationTitle(l10n("voice.language"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("dictation.languages")
    }

    private func row(_ tag: String, title: String? = nil) -> some View {
        Button {
            choice = tag
            dismiss()
        } label: {
            HStack {
                Text(title ?? DictationLanguage.name(tag, in: reader))
                    .foregroundStyle(Tone.text)
                Spacer()
                if selected(tag) {
                    Image(systemName: "checkmark").foregroundStyle(Tone.accent)
                }
            }
        }
        .accessibilityAddTraits(selected(tag) ? .isSelected : [])
    }

    private func selected(_ tag: String) -> Bool {
        tag == DictationLanguage.auto ? choice == tag : choice.caseInsensitiveCompare(tag) == .orderedSame
    }
}
