import SwiftUI

/// The off-canvas drawer: primary rail, conversation switch, the list for
/// the current mode, and the footer (web `PageSidebarNav` + `AppSidebar`).
struct SidebarDrawer: View {
    @EnvironmentObject private var store: AppStore
    /// Opening the drawer dismisses the keyboard; if one is still up (a
    /// sheet, an external keyboard docking) the drawer reserves its height
    /// instead of letting it cover the lower half.
    @StateObject private var keyboard = KeyboardObserver()
    let close: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            if store.drawerPage == .settings {
                SettingsDrawerView()
            } else {
                PrimaryRail()
                ConversationSwitch()
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                Divider().overlay(CoreHubTokens.Palette.borderLight)
                modeList
                Divider().overlay(CoreHubTokens.Palette.borderLight)
                DrawerFooter()
            }
        }
        .padding(.bottom, keyboard.overlap)
        .background(CoreHubTokens.Palette.bgSidebar.ignoresSafeArea())
        .overlay(alignment: .trailing) { Rectangle().fill(CoreHubTokens.Palette.border).frame(width: 1).ignoresSafeArea() }
        // One explicit inset (above) instead of SwiftUI's automatic one,
        // which does not reach this branch of the shell's ZStack.
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .onChange(of: store.drawerOpen) { _, open in if open { Task { await store.checkHealth() } } }
    }

    private var header: some View {
        HStack(spacing: 10) {
            if store.drawerPage == .settings {
                Button { withAnimation(CoreHubTokens.Motion.quick) { store.drawerPage = .navigation } } label: {
                    HStack(spacing: 6) { CoreHubIconView(icon: .back, size: 18); Text("Back").font(CoreHubTokens.Typography.navItemFont) }
                        .foregroundStyle(CoreHubTokens.Palette.textPrimary)
                }
            } else {
                AppMark(size: 26)
                Text("Core Hub").font(CoreHubTokens.Typography.titleFont).foregroundStyle(CoreHubTokens.Palette.textPrimary)
            }
            Spacer()
            Button(action: close) {
                CoreHubIconView(icon: .close, size: 20).foregroundStyle(CoreHubTokens.Palette.textSecondary).frame(width: 34, height: 34).contentShape(Rectangle())
            }
            .accessibilityLabel("Close menu")
        }
        .padding(.horizontal, 14)
        .frame(height: CoreHubTokens.Layout.headerHeight)
    }

    @ViewBuilder private var modeList: some View {
        switch store.conversationMode {
        case .chat, .history: SessionListView()
        case .group: DrawerRoomList()
        case .workflow: DrawerWorkflowList()
        }
    }
}

// MARK: - Primary rail

struct PrimaryRail: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(spacing: 2) {
            RailRow(icon: .newChat, title: "New Chat") { store.startNewChat() }
            RailRow(icon: .search, title: "Search") { store.switchMode(.history) }
            RailRow(icon: .deviceConnections, title: "Device connections", selected: store.shellDestination == .connections) { store.show(.connections) }
            if store.isSuperAdmin {
                RailRow(icon: .agentManager, title: "Agent Manager", selected: store.shellDestination == .agentManager) { store.show(.agentManager) }
            }
            RailRow(icon: .models, title: "Models", selected: store.shellDestination == .models) { store.show(.models) }
        }
        .padding(.horizontal, 8)
        .padding(.top, 4)
    }
}

struct RailRow: View {
    let icon: CoreHubIcon
    let title: LocalizedStringKey
    var selected = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                CoreHubIconView(icon: icon, size: CoreHubTokens.Layout.railIcon)
                Text(title).font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.navItem, weight: selected ? .medium : .regular))
                Spacer(minLength: 0)
            }
            .foregroundStyle(selected ? CoreHubTokens.Palette.textPrimary : CoreHubTokens.Palette.textSecondary)
            .padding(.horizontal, 10)
            .frame(height: 36)
            .background(selected ? CoreHubTokens.Palette.selected : Color.clear, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.button, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(RailButtonStyle())
    }
}

/// Hover/pressed state = accent @ 6 %.
struct RailButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? CoreHubTokens.Palette.hover : Color.clear, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.button, style: .continuous))
    }
}

// MARK: - Conversation switch (4 segments, 30 pt, radius 5, track accent @ 5 %)

struct ConversationSwitch: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        HStack(spacing: 2) {
            ForEach(ConversationMode.allCases) { mode in
                let active = store.conversationMode == mode
                Button { withAnimation(CoreHubTokens.Motion.quick) { store.switchMode(mode) } } label: {
                    VStack(spacing: 2) {
                        CoreHubIconView(icon: mode.icon, size: 16)
                        Text(mode.title)
                            .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.groupHeader, weight: active ? .semibold : .regular))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .foregroundStyle(active ? CoreHubTokens.Palette.textPrimary : CoreHubTokens.Palette.textSecondary)
                    .frame(maxWidth: .infinity)
                    .frame(height: CoreHubTokens.Layout.segmentHeight + 12)
                    .background(active ? CoreHubTokens.Palette.bgCard : Color.clear, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.segment, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(mode.title)
                .accessibilityAddTraits(active ? [.isSelected] : [])
            }
        }
        .padding(2)
        .background(CoreHubTokens.Palette.segmentTrack, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.segment + 2, style: .continuous))
    }
}

// MARK: - Group rooms and workflows inside the drawer

struct DrawerRoomList: View {
    @EnvironmentObject private var store: AppStore
    @State private var rooms: [Room] = []
    @State private var loading = true

    var body: some View {
        List {
            Section {
                if loading && rooms.isEmpty { ProgressView().frame(maxWidth: .infinity) }
                if !loading && rooms.isEmpty { Text("No groups").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted) }
                ForEach(rooms) { room in
                    Button { store.open(room) } label: {
                        RoomRowView(room: room, selected: store.selectedRoom?.id == room.id, time: SessionTimeFormatter.string(for: room.updatedAt ?? "", locale: store.locale))
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 6))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
            } header: {
                HStack(spacing: 4) {
                    GroupHeaderLabel(title: String(localized: "Group Chat"), count: rooms.count)
                    Button { store.roomAction = .create } label: { CoreHubIconView(icon: .plus, size: 14).foregroundStyle(CoreHubTokens.Palette.textMuted).frame(width: 24, height: 24).contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("New room")
                    Button { store.roomAction = .join } label: { Image(systemName: "link").font(.system(size: 12)).foregroundStyle(CoreHubTokens.Palette.textMuted).frame(width: 24, height: 24).contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Join by code")
                }
            }
        }
        .drawerListStyle()
        .task(id: store.sessionListVersion) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        rooms = (await store.attempt({ try await store.api.rooms() })) ?? rooms
        loading = false
    }
}

struct DrawerWorkflowList: View {
    @EnvironmentObject private var store: AppStore
    @State private var workflows: [WorkflowItem] = []
    @State private var loading = true

    var body: some View {
        List {
            Section {
                if loading && workflows.isEmpty { ProgressView().frame(maxWidth: .infinity) }
                if !loading && workflows.isEmpty { Text("No workflows").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted) }
                ForEach(workflows) { workflow in
                    Button { store.open(workflow) } label: {
                        HStack(spacing: 8) {
                            CoreHubIconView(icon: .workflow, size: 16).foregroundStyle(CoreHubTokens.Palette.textSecondary)
                            DirectionalText(text: workflow.name, font: CoreHubTokens.Typography.sessionTitleFont)
                            Text("\(workflow.nodeCount)").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted)
                        }
                        .padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(store.selectedWorkflow?.id == workflow.id ? CoreHubTokens.Palette.selected : Color.clear)
                }
            } header: { GroupHeaderLabel(title: String(localized: "Workflow"), count: workflows.count) }
        }
        .drawerListStyle()
        .task(id: "\(store.selectedProfile)|\(store.sessionListVersion)") { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        workflows = (await store.attempt({ try await store.api.workflows(profile: store.selectedProfile) })) ?? workflows
        loading = false
    }
}

/// 10/600 uppercase group header with +0.5 tracking and a muted count.
struct GroupHeaderLabel: View {
    let title: String
    var count: Int? = nil
    var expanded: Bool? = nil

    var body: some View {
        HStack(spacing: 6) {
            if let expanded {
                CoreHubIconView(icon: .chevronForward, size: CoreHubTokens.Layout.groupChevron)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .animation(CoreHubTokens.Motion.quick, value: expanded)
            }
            Text(title.uppercased())
                .font(CoreHubTokens.Typography.groupHeaderFont)
                .tracking(CoreHubTokens.Typography.groupHeaderTracking)
            if let count {
                Text("\(count)").font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.groupHeader)).foregroundStyle(CoreHubTokens.Palette.textMuted)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(CoreHubTokens.Palette.textSecondary)
        .textCase(nil)
    }
}

extension View {
    /// Plain list on the sidebar background with tight insets.
    func drawerListStyle() -> some View {
        listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(CoreHubTokens.Palette.bgSidebar)
            .environment(\.defaultMinListRowHeight, 32)
    }
}

// MARK: - Footer

struct DrawerFooter: View {
    @EnvironmentObject private var store: AppStore
    @State private var models: [ModelOption] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                profileSelector
                modelSelector
            }
            HStack(spacing: 8) {
                Button { store.signOut() } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "rectangle.portrait.and.arrow.right").font(.system(size: 12, weight: .medium))
                        Text("Sign Out").font(CoreHubTokens.Typography.metaFont)
                    }
                }
                .buttonStyle(CoreHubPillButtonStyle())
                if let username = store.currentUser?.username, !username.isEmpty {
                    Text(username)
                        .font(CoreHubTokens.Typography.metaFont)
                        .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                        .lineLimit(1)
                        .padding(.horizontal, 8)
                        .frame(height: 22)
                        .background(CoreHubTokens.Palette.hover, in: Capsule())
                }
                Spacer(minLength: 0)
                Button { withAnimation(CoreHubTokens.Motion.quick) { store.drawerPage = .settings } } label: {
                    CoreHubIconView(icon: .settings, size: 18).foregroundStyle(CoreHubTokens.Palette.textSecondary).frame(width: 32, height: 32).contentShape(Rectangle())
                }
                .accessibilityLabel("Settings")
            }
            HStack(spacing: 8) {
                Circle().fill(store.connected ? CoreHubTokens.Palette.success : CoreHubTokens.Palette.error).frame(width: 7, height: 7)
                Text(store.connected ? "Connected" : "Disconnected").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted)
                Spacer(minLength: 0)
                languageSwitch
                themeSwitch
            }
            HStack(spacing: 8) {
                Text(verbatim: "Core Hub v\(store.serverVersion.nilIfEmpty ?? "—")")
                    .font(CoreHubTokens.Typography.metaFont)
                    .foregroundStyle(CoreHubTokens.Palette.textMuted)
                    .environment(\.layoutDirection, .leftToRight)
                Spacer(minLength: 0)
                Link(destination: URL(string: "https://github.com/twuijri/core-hub")!) {
                    Image("GitHubMark").resizable().renderingMode(.template).scaledToFit().frame(width: 14, height: 14).foregroundStyle(CoreHubTokens.Palette.textMuted)
                }
                .accessibilityLabel("GitHub")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .task(id: store.selectedProfile) {
            models = (await store.attempt { try await store.api.models(profile: store.selectedProfile) }) ?? []
        }
    }

    private var profileSelector: some View {
        Menu {
            ForEach(store.profiles) { profile in
                Button { store.chooseProfile(profile.name) } label: {
                    if profile.name == store.selectedProfile { Label(profile.name, systemImage: "checkmark") } else { Text(profile.name) }
                }
            }
            Divider()
            Button("Manage profiles") { store.show(.profiles) }
        } label: {
            HStack(spacing: 6) {
                ProfileAvatar(name: store.selectedProfile, avatar: store.profile?.avatar, size: 18)
                Text(store.selectedProfile).font(CoreHubTokens.Typography.sidebarTabFont).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(CoreHubTokens.Palette.textMuted)
            }
            .foregroundStyle(CoreHubTokens.Palette.textPrimary)
            .padding(.horizontal, 8)
            .frame(height: 30)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CoreHubTokens.Palette.bgCard, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.button, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: CoreHubTokens.Radius.button, style: .continuous).stroke(CoreHubTokens.Palette.border, lineWidth: 1))
        }
        .accessibilityLabel("Profile")
    }

    private var modelSelector: some View {
        Menu {
            Button { store.setPreferredModel("") } label: {
                if store.preferredModel.isEmpty { Label("Profile default", systemImage: "checkmark") } else { Text("Profile default") }
            }
            Divider()
            ForEach(models) { model in
                Button { store.setPreferredModel(model.id) } label: {
                    if model.id == store.preferredModel { Label(model.name, systemImage: "checkmark") } else { Text(model.name) }
                }
            }
        } label: {
            HStack(spacing: 6) {
                CoreHubIconView(icon: .models, size: 14)
                TechnicalText(text: store.preferredModel.nilIfEmpty ?? store.profile?.model ?? String(localized: "Model"), font: CoreHubTokens.Typography.sidebarTabFont, color: CoreHubTokens.Palette.textPrimary)
            }
            .foregroundStyle(CoreHubTokens.Palette.textPrimary)
            .padding(.horizontal, 8)
            .frame(height: 30)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CoreHubTokens.Palette.bgCard, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.button, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: CoreHubTokens.Radius.button, style: .continuous).stroke(CoreHubTokens.Palette.border, lineWidth: 1))
        }
        .accessibilityLabel("Model")
    }

    @ViewBuilder private func checked(_ title: LocalizedStringKey, _ on: Bool) -> some View {
        if on { Label(title, systemImage: "checkmark") } else { Text(title) }
    }

    private var languageSwitch: some View {
        Menu {
            Button { store.setLanguage("system") } label: { checked("System", store.language == "system") }
            Button { store.setLanguage("ar") } label: { checked("العربية", store.language == "ar") }
            Button { store.setLanguage("en") } label: { checked("English", store.language == "en") }
        } label: {
            Text(verbatim: store.language == "ar" ? "ع" : store.language == "en" ? "EN" : "A")
                .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.meta, weight: .semibold))
                .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                .frame(width: 28, height: 24)
                .background(CoreHubTokens.Palette.hover, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.tag))
        }
        .accessibilityLabel("Language")
    }

    private var themeSwitch: some View {
        Menu {
            Button { store.setAppearance("system") } label: { checked("System", store.appearance == "system") }
            Button { store.setAppearance("light") } label: { checked("Light", store.appearance == "light") }
            Button { store.setAppearance("dark") } label: { checked("Dark", store.appearance == "dark") }
        } label: {
            Image(systemName: store.appearance == "dark" ? "moon.fill" : store.appearance == "light" ? "sun.max.fill" : "circle.lefthalf.filled")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                .frame(width: 28, height: 24)
                .background(CoreHubTokens.Palette.hover, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.tag))
        }
        .accessibilityLabel("Theme")
    }
}
