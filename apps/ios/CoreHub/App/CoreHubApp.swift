import SwiftUI

@main
struct CoreHubApp: App {
    @State private var app = AppModel()
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
            if phase == .background, app.device.backgroundChecks { NoticeRefresh.schedule() }
        }
        .backgroundTask(.appRefresh(NoticeRefresh.identifier)) {
            await LocalNotices.shared.catchUp(app: app)
            await MainActor.run { NoticeRefresh.schedule() }
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
