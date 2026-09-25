// Settings (destination `settings`) on a phone: the list is the page itself (NAVIGATION.md §٢),
// its first row goes back to the chats, and each page opened from it shows the way back.
import SwiftUI
import UserNotifications

struct SettingsScreen: View {
    let backToChats: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button(action: backToChats) {
                        Label(l10n("settings.back_to_chats"), systemImage: "chevron.backward")
                    }
                    .accessibilityIdentifier("settings.back_to_chats")
                }
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
                Label(l10n(destination.titleKey), systemImage: Icons.symbol(for: destination))
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
            case .users: UsersPage()
            case .webhooks: WebhooksPage()
            case .display: DisplayPage()
            case .notifications: NotificationsPage()
            case .privacy: PrivacyPage()
            case .thisDevice: ThisDevicePage()
            case .about: AboutPage()
            case .models: ModelsPage()
            case .deviceConnections: DeviceConnectionsPage()
            case .knowledge: KnowledgePage()
            case .logs: AuditPage(kind: .logs)
            case .usage: AuditPage(kind: .usage)
            case .performance: AuditPage(kind: .performance)
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
    @State private var notifications: UNAuthorizationStatus = .notDetermined

    var body: some View {
        @Bindable var device = app.device
        Section(l10n("device.voice")) {
            Toggle(l10n("device.voice_input"), isOn: $device.voiceInput)
            Picker(l10n("device.dictation_language"), selection: $device.dictationLanguage) {
                Text(l10n("device.dictation_app")).tag(DeviceSettings.DictationLanguage.app)
                Text(l10n("shell.language_ar")).tag(DeviceSettings.DictationLanguage.ar)
                Text(l10n("shell.language_en")).tag(DeviceSettings.DictationLanguage.en)
            }
            Toggle(l10n("device.spoken_replies"), isOn: $device.spokenReplies)
        }
        Section {
            switch notifications {
            case .authorized, .provisional, .ephemeral:
                FactRow(label: l10n("device.notifications"), value: l10n("device.notifications_allowed"))
            case .denied:
                FactRow(label: l10n("device.notifications"), value: l10n("device.notifications_denied"))
            default:
                Button(l10n("device.notifications_ask")) {
                    Task {
                        _ = await LocalNotices.shared.requestPermission()
                        notifications = await LocalNotices.shared.status()
                    }
                }
            }
        } header: {
            Text(l10n("device.notifications"))
        } footer: {
            Text(l10n("device.notifications_note"))
        }
        .task { notifications = await LocalNotices.shared.status() }
    }
}
