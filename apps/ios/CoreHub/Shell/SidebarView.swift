// The drawer: brand, the profile selector (proposed phone placement: here, not a top bar), the
// rail in manifest order, the Chat | Rooms segments with the list below, and the footer.
import CoreHubClient
import SwiftUI

struct SidebarView: View {
    @Binding var segment: DestinationID
    let sessionList: SessionListModel
    let selectedSession: String?
    let navigate: (MainContent) -> Void
    let openSession: (Session) -> Void
    let close: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, Space.s4)
                .padding(.top, Space.s3)
            ScrollView {
                VStack(alignment: .leading, spacing: Space.s1) {
                    ForEach(NavigationMap.visible(NavigationMap.rail, admin: app.isAdmin)) { destination in
                        railRow(destination)
                    }
                    segments
                        .padding(.top, Space.s3)
                    if segment == .chat {
                        SessionListView(model: sessionList, selected: selectedSession, open: openSession)
                    } else {
                        RoomsList()
                    }
                }
                .padding(.horizontal, Space.s3)
                .padding(.vertical, Space.s3)
            }
            .scrollDismissesKeyboard(.interactively)
            footer
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background {
            Rectangle()
                .fill(.regularMaterial)
                .overlay(Tone.bgRaised.opacity(0.55))
                .ignoresSafeArea()
        }
        .accessibilityIdentifier("shell.sidebar")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            HStack(spacing: Space.s2) {
                BrandMark(size: 28)
                Text(l10n.productName)
                    .font(.system(size: FontSize.sizeLg, weight: .bold))
                    .foregroundStyle(Tone.text)
                Spacer()
                Button(action: close) {
                    LucideIcon(.x, size: 20)
                        .foregroundStyle(Tone.textMuted)
                        .tapTarget()
                }
                .accessibilityLabel(l10n("shell.close_menu"))
            }
            ProfileSelector()
        }
    }

    private func railRow(_ destination: DestinationID) -> some View {
        Button {
            navigate(destination == .newChat ? .newChat : .destination(destination))
        } label: {
            HStack(spacing: Space.s3) {
                LucideIcon(Icons.lucide(for: destination), size: 20)
                    .frame(width: 24)
                    .foregroundStyle(Tone.textMuted)
                Text(l10n(destination.titleKey))
                    .font(.system(size: FontSize.sizeMd))
                    .foregroundStyle(Tone.text)
                Spacer()
            }
            .padding(.horizontal, Space.s2)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("rail.\(destination.rawValue)")
    }

    private var segments: some View {
        Picker("", selection: $segment) {
            ForEach(NavigationMap.segments) { destination in
                Text(l10n(destination.titleKey)).tag(destination)
            }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("shell.segments")
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            Divider().overlay(Tone.border)
            HStack(spacing: Space.s2) {
                Text(app.credentials?.displayName ?? "")
                    .font(.system(size: FontSize.sizeSm, weight: .medium))
                    .foregroundStyle(Tone.text)
                    .lineLimit(1)
                ConnectionDot()
                Spacer()
                ForEach(NavigationMap.footer) { destination in
                    Button {
                        navigate(.settings)
                    } label: {
                        LucideIcon(.settings, size: 20)
                            .tapTarget()
                    }
                    .accessibilityLabel(l10n(destination.titleKey))
                    .accessibilityIdentifier("footer.\(destination.rawValue)")
                }
            }
            HStack(spacing: Space.s2) {
                LanguageMenu()
                Spacer()
                ThemeChips()
            }
            HStack {
                Button(role: .destructive) {
                    Task { await app.signOut() }
                } label: {
                    LucideLabel(l10n("nav.sign_out"), icon: .logOut, size: 16)
                        .font(.system(size: FontSize.sizeSm))
                }
                .accessibilityIdentifier("footer.sign_out")
                Spacer()
                Text(l10n("shell.version", ["version": app.appVersion]))
                    .font(.system(size: FontSize.sizeXs))
                    .foregroundStyle(Tone.textFaint)
            }
        }
        .padding(.horizontal, Space.s4)
        .padding(.bottom, Space.s3)
    }
}

/// The profile selector: always one concrete profile, no «All» (profileScope.selector). It
/// switches `X-Hub-Profile` and never moves the screen.
struct ProfileSelector: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        Menu {
            ForEach(app.enterableProfiles, id: \.self) { slug in
                Button {
                    app.switchProfile(slug)
                } label: {
                    if slug == app.currentProfile {
                        Label { Text(app.profileName(slug)) } icon: { Image(lucide: .check) }
                    } else {
                        Text(app.profileName(slug))
                    }
                }
            }
        } label: {
            HStack(spacing: Space.s2) {
                LucideIcon(.layoutGrid, size: 16)
                Text(app.profileName(app.currentProfile))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if app.enterableProfiles.count > 1 {
                    LucideIcon(.chevronsUpDown, size: 14).foregroundStyle(Tone.textMuted)
                }
            }
            .font(.system(size: FontSize.sizeSm, weight: .medium))
            .foregroundStyle(Tone.text)
            .padding(.horizontal, Space.s3)
            .frame(height: Control.heightMd)
            .background(Tone.surface, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Tone.border))
        }
        .disabled(app.enterableProfiles.count < 2)
        .accessibilityLabel(l10n("shell.profile_current", ["profile": app.profileName(app.currentProfile)]))
        .accessibilityHint(l10n("shell.profile_switch"))
        .accessibilityIdentifier("shell.profile")
    }
}

/// One picture per destination — the Lucide name the web (`destinationIcons`) and Android draw
/// for the same place (docs/design/family.md, "Icons").
enum Icons {
    static func lucide(for destination: DestinationID) -> Lucide {
        switch destination {
        case .newChat: return .squarePen
        case .search: return .search
        case .agentManager: return .bot
        case .tasks: return .listChecks
        case .schedules: return .calendarClock
        case .chat: return .messagesSquare
        case .rooms: return .users
        case .settings: return .settings
        case .account: return .circleUser
        case .users: return .users
        case .webhooks: return .webhook
        case .display: return .type
        case .notifications: return .bell
        case .privacy: return .shieldCheck
        case .thisDevice: return .smartphone
        case .about: return .info
        case .models: return .box
        case .deviceConnections: return .qrCode
        case .knowledge: return .bookOpen
        case .logs: return .scrollText
        case .usage: return .chartColumn
        case .skillsUsage: return .activity
        case .performance: return .gauge
        case .theme: return .palette
        case .workspaces: return .layoutGrid
        case .updates: return .circleArrowDown
        case .plugins: return .puzzle
        case .files: return .folder
        case .agentSkills: return .sparkles
        case .agentMcp: return .server
        case .agentMemory: return .brain
        case .agentJobs: return .rotateCcwClock
        case .agentChannels: return .radio
        case .agentPlugins: return .puzzle
        case .agentSettings: return .slidersHorizontal
        case .globalAgent: return .globe
        }
    }
}
