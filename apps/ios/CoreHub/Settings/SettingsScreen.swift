// Settings (destination `settings`) on a phone: the list is the page itself (NAVIGATION.md §٢),
// the navigation bar goes back to the chats, and each page opened from it shows the way back.
import SwiftUI
import UIKit
import UserNotifications

struct SettingsScreen: View {
    let backToChats: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        NavigationStack {
            List {
                Section {
                    rows(NavigationMap.settingsTabs)
                }
                Section(l10n("settings.management")) {
                    rows(NavigationMap.settingsManagement)
                }
                Section(l10n("settings.tools")) {
                    rows(NavigationMap.settingsTools)
                }
            }
            .navigationTitle(l10n("nav.settings"))
            // The way back to the chats sits where every phone puts "back": the navigation bar,
            // not a row that pushes the list down (docs/design/family.md, "Phone adaptations").
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: backToChats) {
                        LucideIcon(.chevronLeft, size: 20)
                            .flipsForRightToLeftLayoutDirection(true)
                    }
                    .accessibilityLabel(l10n("settings.back_to_chats"))
                    .accessibilityIdentifier("settings.back_to_chats")
                }
            }
            .navigationDestination(for: DestinationID.self) { destination in
                SettingsPage(destination: destination)
            }
            .scrollContentBackground(.hidden)
            .background(Tone.bg)
            .accessibilityIdentifier("screen.settings")
        }
    }

    @ViewBuilder
    private func rows(_ list: [DestinationID]) -> some View {
        ForEach(NavigationMap.visible(list, admin: app.isAdmin)) { destination in
            NavigationLink(value: destination) {
                Label {
                    Text(l10n(destination.titleKey))
                        .foregroundStyle(Tone.text)
                } icon: {
                    LucideIcon(Icons.lucide(for: destination), size: 18)
                        .foregroundStyle(Tone.textMuted)
                }
            }
            .accessibilityIdentifier("settings.\(destination.rawValue)")
        }
    }
}

/// A page under Settings, with its title; the way back is the navigation bar's.
struct SettingsPage: View {
    let destination: DestinationID
    @Environment(\.l10n) private var l10n

    var body: some View {
        Group {
            switch destination {
            case .account: AccountPage()
            case .users: PeopleNativePage()
            case .webhooks: WebhooksPage()
            case .display: DisplayPage()
            case .notifications: NotificationsPage()
            case .privacy: PrivacyPage()
            case .thisDevice: ThisDevicePage()
            case .about: AboutPage()
            case .models: ModelsNativePage()
            case .deviceConnections: DeviceConnectionsPage()
            case .knowledge: KnowledgePage()
            case .logs: LogsPage()
            case .usage: UsageNativePage()
            case .performance: PerformancePage()
            case .theme: ThemePage()
            case .workspaces: WorkspacesPage()
            case .updates: UpdatesPage()
            case .plugins: HubPluginsPage()
            default: PlaceholderScreen(destination: destination)
            }
        }
        .navigationTitle(l10n(destination.titleKey))
        .navigationBarTitleDisplayMode(.inline)
        .background(Tone.bg)
        .accessibilityIdentifier("screen.\(destination.rawValue)")
    }
}

/// This phone's own choices: voice input, the dictation language, spoken replies, and whether
/// the system lets Core Hub show notices.
struct ThisDeviceExtras: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        @Bindable var device = app.device
        Section {
            Picker(l10n("device.voice_source"), selection: $device.voiceSource) {
                Text(l10n("device.voice_hub")).tag(DeviceSettings.VoiceSource.hub)
                Text(l10n("device.voice_phone")).tag(DeviceSettings.VoiceSource.phone)
            }
            .accessibilityIdentifier("device.voice_source")
            Toggle(l10n("device.voice_input"), isOn: $device.voiceInput)
            NavigationLink {
                DictationLanguageList(choice: $device.dictationLanguage)
            } label: {
                LabeledContent(
                    l10n("device.dictation_language"),
                    value: device.dictationLanguage == DictationLanguage.auto ? l10n("voice.language_auto")
                        : DictationLanguage.name(device.dictationLanguage, in: app.language.rawValue)
                )
            }
            .accessibilityIdentifier("device.dictation_language")
            Toggle(l10n("device.spoken_replies"), isOn: $device.spokenReplies)
        } header: {
            Text(l10n("device.voice"))
        } footer: {
            Text(l10n("device.voice_source_hint"))
        }
        Section {
            Toggle(l10n("device.background_checks"), isOn: $device.backgroundChecks)
        }
        PushStatusSection()
    }

    /// What This device says about push, by its state (PushCenter).
    nonisolated static func pushNote(_ state: PushState) -> String {
        switch state {
        case .active: return "device.push_active"
        case .idle: return "device.push_idle"
        case .waiting, .notAllowed: return "device.push_not_allowed"
        case .noSender: return "device.push_no_sender"
        case .failed: return "device.push_failed"
        }
    }

    /// The state in plain words, for the row.
    nonisolated static func pushLabel(_ state: PushState) -> String {
        switch state {
        case .active: return "device.push_on"
        case .idle: return "device.push_setting_up"
        case .waiting: return "device.push_waiting"
        case .notAllowed: return "device.push_off"
        case .noSender: return "device.push_no_sender_short"
        case .failed: return "device.push_failed_short"
        }
    }
}

/// Push on this phone, in plain words (This device, and Settings → Notifications): the state,
/// and what the person can do about it — allow while iOS has not asked, or open the iPhone's
/// Settings once they turned notifications off (the app cannot ask again then).
struct PushStatusSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let state = PushCenter.shared.state
        Section {
            FactRow(label: l10n("device.notifications"), value: l10n(ThisDeviceExtras.pushLabel(state)))
                .accessibilityIdentifier("push.state")
            switch state {
            case .notAllowed:
                Button {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(l10n("device.notifications_off"))
                            .foregroundStyle(Tone.text)
                        Text(l10n("device.open_settings"))
                            .font(.system(size: FontSize.sizeSm, weight: .medium))
                    }
                }
                .accessibilityIdentifier("push.open_settings")
            case .waiting:
                Button(l10n("device.notifications_ask")) {
                    Task {
                        _ = await LocalNotices.shared.requestPermission()
                        await PushCenter.shared.start(app: app)
                    }
                }
            default:
                EmptyView()
            }
        } header: {
            Text(l10n("device.notifications"))
        } footer: {
            Text(l10n(ThisDeviceExtras.pushNote(state)))
        }
        // Back from the iPhone's Settings: read the permission again.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await PushCenter.shared.foreground(app: app) } }
        }
    }
}
