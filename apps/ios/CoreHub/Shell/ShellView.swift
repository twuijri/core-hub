// The phone shell (NAVIGATION.md §١ on a phone): the page fills the screen and the sidebar is a
// drawer from the reading-start edge, opened by the menu button. The drawer holds the rail, the
// Chat | Rooms segments with their list, and the footer. Settings replaces the page with its
// list and a «Back to chats» row (§٢); nothing here keeps a top bar on the chat.
import CoreHubClient
import SwiftUI

enum MainContent: Equatable {
    case newChat
    case chat(sessionID: String, profile: String)
    case destination(DestinationID)
    case settings
}

struct ShellView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var main: MainContent = .newChat
    @State private var beforeSettings: MainContent = .newChat
    @State private var drawerOpen = false
    @State private var segment: DestinationID = .chat
    @State private var sessionList: SessionListModel?
    /// The first message of a chat made from the draft, handed to its conversation once.
    @State private var firstMessages = FirstMessages()
    @State private var searching = false
    /// A shared text waiting in the new chat's composer.
    @State private var seed: String?

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                page
                if drawerOpen, let sessionList {
                    Tone.scrim
                        .ignoresSafeArea()
                        .onTapGesture { setDrawer(false) }
                        .accessibilityLabel(l10n("shell.close_menu"))
                        .accessibilityAddTraits(.isButton)
                    SidebarView(
                        segment: $segment,
                        sessionList: sessionList,
                        selectedSession: selectedSession,
                        navigate: navigate,
                        openSession: { session in
                            navigate(.chat(sessionID: session.id, profile: session.profile))
                        },
                        close: { setDrawer(false) }
                    )
                    .frame(width: min(Layout.sidebarWidth + Space.s8, geometry.size.width * 0.86))
                    .transition(.move(edge: .leading))
                    .zIndex(1)
                }
            }
        }
        .onAppear {
            if sessionList == nil { sessionList = SessionListModel(app: app) }
            takeLink()
            takeDraft()
        }
        .onChange(of: app.pendingRoute) { _, _ in takeLink() }
        .onChange(of: app.pendingDraft) { _, _ in takeDraft() }
        .sheet(isPresented: $searching) {
            SearchScreen(
                openChat: { session in navigate(.chat(sessionID: session.id, profile: session.profile)) },
                openGlobalAgent: { navigate(.destination(.globalAgent)) }
            )
        }
    }

    /// Text shared from another app opens a new chat with it in the composer.
    private func takeDraft() {
        guard let draft = app.pendingDraft else { return }
        app.pendingDraft = nil
        seed = draft
        navigate(.newChat)
    }

    /// A `corehub://open/…` link the app was opened with.
    private func takeLink() {
        guard let route = app.pendingRoute else { return }
        app.pendingRoute = nil
        navigate(route)
    }

    private var selectedSession: String? {
        if case .chat(let id, _) = main { return id }
        return nil
    }

    @ViewBuilder
    private var page: some View {
        switch main {
        case .settings:
            SettingsScreen(backToChats: { navigate(beforeSettings) })
        case .destination(.agentManager):
            // The Agents page keeps its own stack: an agent's pages are pushed on it.
            AgentsScreen(openMenu: { setDrawer(true) })
        default:
            NavigationStack {
                content
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button {
                                setDrawer(true)
                            } label: {
                                Image(systemName: "line.3.horizontal")
                            }
                            .accessibilityLabel(l10n("shell.open_menu"))
                            .accessibilityIdentifier("shell.menu")
                        }
                    }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch main {
        case .newChat:
            NewChatScreen(opened: { sessionID, profile, text in
                firstMessages.put(sessionID, text)
                seed = nil
                main = .chat(sessionID: sessionID, profile: profile)
            }, seed: seed)
            .id(seed ?? "")
        case .chat(let sessionID, let profile):
            ChatScreen(model: ChatModel(
                app: app,
                sessionID: sessionID,
                profile: profile,
                firstMessage: firstMessages.take(sessionID)
            ))
            .id(sessionID)
        case .destination(.tasks):
            TasksScreen(openChat: { sessionID, profile in navigate(.chat(sessionID: sessionID, profile: profile)) })
        case .destination(.schedules):
            SchedulesScreen()
        case .destination(.globalAgent):
            GlobalAgentScreen()
        case .destination(let destination):
            PlaceholderScreen(destination: destination)
        case .settings:
            EmptyView()
        }
    }

    private func navigate(_ target: MainContent) {
        if target == .destination(.search) {
            setDrawer(false)
            searching = true
            return
        }
        if target == .settings, main != .settings { beforeSettings = main }
        main = target
        setDrawer(false)
    }

    private func setDrawer(_ open: Bool) {
        withAnimation(.easeInOut(duration: Motion.normal)) { drawerOpen = open }
    }
}

/// Not view state: taking a message must not redraw the shell.
final class FirstMessages {
    private var pending: [String: String] = [:]

    func put(_ sessionID: String, _ text: String) { pending[sessionID] = text }

    func take(_ sessionID: String) -> String? { pending.removeValue(forKey: sessionID) }
}
