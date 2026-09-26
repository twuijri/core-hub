// The phone shell (NAVIGATION.md §١ on a phone): the page fills the screen and the sidebar is a
// drawer from the reading-start edge, opened by the menu button. The drawer holds the rail, the
// Chat | Rooms segments with their list, and the footer. Settings replaces the page with its
// list and a «Back to chats» row (§٢); nothing here keeps a top bar on the chat.
import CoreHubClient
import SwiftUI

enum MainContent: Equatable {
    case newChat
    case chat(sessionID: String, profile: String)
    /// One room, opened from the Rooms segment, in its own profile.
    case room(roomID: String, profile: String)
    case destination(DestinationID)
    case settings
}

struct ShellView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var main: MainContent = .newChat
    @State private var beforeSettings: MainContent = .newChat
    @State private var drawer = DrawerState()
    @State private var segment: DestinationID = .chat
    @State private var sessionList: SessionListModel?
    /// The first message of a chat made from the draft, handed to its conversation once.
    @State private var firstMessages = FirstMessages()
    @State private var searching = false
    /// A shared text waiting in the new chat's composer.
    @State private var seed: String?
    @State private var pending: PendingModel?
    @State private var showingPending = false

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                page
                if drawer.isOpen, let sessionList {
                    Tone.scrim
                        .ignoresSafeArea()
                        .onTapGesture { setDrawer(false) }
                        .accessibilityLabel(l10n("shell.close_menu"))
                        .accessibilityAddTraits(.isButton)
                    SidebarView(
                        segment: $segment,
                        sessionList: sessionList,
                        selectedSession: selectedSession,
                        selectedRoom: selectedRoom,
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
            if pending == nil { pending = PendingModel(app: app) }
            pending?.start()
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
        .sheet(isPresented: $showingPending) {
            if let pending {
                NavigationStack { PendingSheet(model: pending, go: navigate) }
            }
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

    private var selectedRoom: String? {
        if case .room(let id, _) = main { return id }
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
                                LucideIcon(.menu, size: 20)
                            }
                            .accessibilityLabel(l10n("shell.open_menu"))
                            .accessibilityIdentifier("shell.menu")
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            if let pending {
                                PendingButton(model: pending) { showingPending = true }
                            }
                        }
                    }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch main {
        case .newChat:
            NewChatScreen(opened: { sessionID, profile, message in
                firstMessages.put(sessionID, message)
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
        case .room(let roomID, let profile):
            RoomScreen(
                model: RoomModel(app: app, roomID: roomID, profile: profile),
                onGone: { navigate(.newChat) }
            )
            .id(roomID)
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
        if case .room = target { segment = .rooms }
        if target == .settings, main != .settings { beforeSettings = main }
        main = target
        setDrawer(false)
    }

    private func setDrawer(_ open: Bool) {
        drawer.set(open)
    }
}

/// Not view state: taking a message must not redraw the shell.
final class FirstMessages {
    private var pending: [String: OutgoingMessage] = [:]

    func put(_ sessionID: String, _ message: OutgoingMessage) { pending[sessionID] = message }

    func take(_ sessionID: String) -> OutgoingMessage? { pending.removeValue(forKey: sessionID) }
}
