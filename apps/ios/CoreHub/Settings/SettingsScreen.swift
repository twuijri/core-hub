// Settings (destination `settings`) on a phone: the list is the page itself (NAVIGATION.md §٢),
// its first row goes back to the chats, and each page opened from it shows the way back.
import SwiftUI

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

/// What part 3 adds to This device (voice input, dictation, spoken replies).
struct ThisDeviceExtras: View {
    var body: some View { EmptyView() }
}
