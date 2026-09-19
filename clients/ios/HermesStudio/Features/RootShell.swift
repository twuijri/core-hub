import SwiftUI

/// Signed-in root: a navigation bar with a hamburger, the content of the
/// current conversation mode, and the off-canvas drawer (250 ms slide, 40 %
/// scrim, swipe to close, edge swipe to open) — the web's mobile layout.
struct RootShell: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.layoutDirection) private var layoutDirection
    /// Finger travel along the closing direction while dragging (≤ 0).
    @State private var drag: CGFloat = 0

    private var sign: CGFloat { layoutDirection == .rightToLeft ? -1 : 1 }

    var body: some View {
        GeometryReader { geometry in
            let width = min(CoreHubTokens.Layout.drawerMaxWidth, geometry.size.width * CoreHubTokens.Layout.drawerWidthFraction)
            let progress: CGFloat = store.drawerOpen ? max(0, 1 + drag / width) : 0
            ZStack(alignment: .leading) {
                NavigationStack { content }
                    .id(store.languageRefresh)
                    .accessibilityHidden(store.drawerOpen)

                Color.black
                    .opacity(CoreHubTokens.Alpha.drawerScrim * progress)
                    .ignoresSafeArea()
                    .allowsHitTesting(store.drawerOpen)
                    .onTapGesture { close() }
                    .accessibilityLabel("Close menu")

                SidebarDrawer(close: close)
                    .frame(width: width)
                    .offset(x: sign * (store.drawerOpen ? drag : -width))
                    .simultaneousGesture(closeGesture(width: width))
                    .accessibilityHidden(!store.drawerOpen)

                if !store.drawerOpen {
                    Color.clear
                        .frame(width: CoreHubTokens.Layout.edgeSwipeWidth)
                        .contentShape(Rectangle())
                        .gesture(openGesture)
                }
            }
            .animation(CoreHubTokens.Motion.drawer, value: store.drawerOpen)
        }
        .task { await store.checkHealth() }
    }

    private func close() {
        store.drawerOpen = false
        drag = 0
    }

    private func closeGesture(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                drag = min(0, value.translation.width * sign)
            }
            .onEnded { value in
                let travelled = -value.translation.width * sign
                let flung = -value.predictedEndTranslation.width * sign > width / 2
                if travelled > width / 3 || flung { close() } else { withAnimation(CoreHubTokens.Motion.drawer) { drag = 0 } }
            }
    }

    private var openGesture: some Gesture {
        DragGesture(minimumDistance: 10)
            .onEnded { value in
                if value.translation.width * sign > 24 { store.drawerOpen = true }
            }
    }

    @ViewBuilder private var content: some View {
        Group {
            switch store.conversationMode {
            case .chat:
                if let session = store.selectedSession {
                    ConversationView(session: session, embeddedInShell: true).id(session.id)
                } else {
                    ChatHomeView().shellToolbar()
                }
            case .group:
                if let room = store.selectedRoom {
                    GroupRoomView(room: room).id(room.id)
                } else {
                    GroupsView().shellToolbar()
                }
            case .workflow:
                if let workflow = store.selectedWorkflow {
                    WorkflowDetailView(workflow: workflow).id(workflow.id).shellToolbar()
                } else {
                    WorkflowsView().shellToolbar()
                }
            case .history:
                ChatsView().shellToolbar()
            }
        }
        .hermesBackground()
        .toolbarBackground(CoreHubTokens.Palette.bgPrimary, for: .navigationBar)
        .navigationDestination(item: $store.shellDestination) { destination in
            ShellDestinationView(destination: destination)
        }
        .sheet(item: $store.roomAction) { action in
            switch action {
            case .create: CreateRoomView().environmentObject(store)
            case .join: JoinRoomView().environmentObject(store)
            }
        }
    }
}

/// Pushed screens for the drawer rail and the settings drawer. Screens that
/// do not exist yet show a placeholder instead of disappearing.
struct ShellDestinationView: View {
    @EnvironmentObject private var store: AppStore
    let destination: ShellDestination

    var body: some View {
        switch destination {
        case .connections: StudioConnectionsView()
        case .agentManager: AgentManagerView()
        case .models: ModelsView()
        case .logs: StudioLogsView()
        case .usage: InsightsView()
        case .performance: InsightsView()
        case .skillsUsage: SkillUsageView()
        case .theme: ThemeStudioView()
        case .pets: PetsView()
        case .profiles: ProfilesView()
        case .settings: SettingsView()
        }
    }
}

/// Empty chat surface shown before a session is chosen.
struct ChatHomeView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(spacing: 18) {
            AppMark(size: 72)
            Text("Core Hub").font(CoreHubTokens.Typography.titleFont).foregroundStyle(CoreHubTokens.Palette.textPrimary)
            Text("Start a conversation or pick one from the menu.")
                .font(CoreHubTokens.Typography.bodyFont)
                .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                .multilineTextAlignment(.center)
            Button { store.startNewChat() } label: {
                HStack(spacing: 8) { CoreHubIconView(icon: .newChat, size: 16); Text("New Chat") }
            }
            .buttonStyle(CoreHubPillButtonStyle(prominent: true))
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("Core Hub")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The hamburger that opens the drawer.
struct DrawerButton: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        Button { store.drawerPage = .navigation; store.drawerOpen = true } label: {
            CoreHubIconView(icon: .menu, size: 22)
                .foregroundStyle(CoreHubTokens.Palette.textPrimary)
                .frame(width: 38, height: 38)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Menu")
    }
}

extension View {
    /// Adds the hamburger to a root screen of the shell.
    func shellToolbar() -> some View {
        toolbar { ToolbarItem(placement: .topBarLeading) { DrawerButton() } }
    }
}

/// Pill button (radius 999) in the accent colour or as an outlined chip.
struct CoreHubPillButtonStyle: ButtonStyle {
    var prominent = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.sidebarTab, weight: .medium))
            .foregroundStyle(prominent ? CoreHubTokens.Palette.textOnAccent : CoreHubTokens.Palette.textPrimary)
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(prominent ? CoreHubTokens.Palette.accent : CoreHubTokens.Palette.bgCard, in: Capsule())
            .overlay(Capsule().stroke(prominent ? Color.clear : CoreHubTokens.Palette.inputBorderIdle, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
