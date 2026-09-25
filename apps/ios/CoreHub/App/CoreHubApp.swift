import SwiftUI

@main
struct CoreHubApp: App {
    /// The APNs token and notification taps from before the first screen (Phone/Push.swift).
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    #if DEBUG
    /// The demo hub keeps its sign-in apart from a real one (DemoHub.swift).
    @State private var app = DemoHub.isOn
        ? AppModel(keeper: TokenKeeper(store: KeychainStore(service: DemoHub.keychainService)))
        : AppModel()
    #else
    @State private var app = AppModel()
    #endif
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(\.l10n, app.l10n)
                .environment(\.layoutDirection, app.language.layoutDirection)
                .environment(\.locale, app.language.locale)
                .preferredColorScheme(app.theme.colorScheme)
                .tint(Tone.accent)
                .task { await app.launch() }
                .onOpenURL { url in app.open(url) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { app.becameActive() }
            // The background look only while push is not carrying the notices already.
            if phase == .background, app.device.backgroundChecks, !PushCenter.shared.isActive { NoticeRefresh.schedule() }
        }
        .backgroundTask(.appRefresh(NoticeRefresh.identifier)) {
            await LocalNotices.shared.catchUp(app: app)
            await MainActor.run { if !PushCenter.shared.isActive { NoticeRefresh.schedule() } }
        }
    }
}

/// Before sign-in: the sign-in screen (NAVIGATION.md §٠); after: the shell.
struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            switch app.phase {
            case .launching:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Tone.bg)
            case .signedOut:
                LoginScreen()
            case .signedIn:
                ShellView()
            }
        }
        .animation(.easeInOut(duration: Motion.normal), value: app.phase)
    }
}
