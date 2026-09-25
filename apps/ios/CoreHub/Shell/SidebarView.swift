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
                    Image(systemName: "xmark")
                        .font(.system(size: FontSize.sizeMd))
                        .foregroundStyle(Tone.textMuted)
                        .frame(width: Control.heightMd, height: Control.heightMd)
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
                Image(systemName: Icons.symbol(for: destination))
                    .frame(width: 20)
                    .foregroundStyle(Tone.textMuted)
                Text(l10n(destination.titleKey))
                    .font(.system(size: FontSize.sizeMd))
                    .foregroundStyle(Tone.text)
                Spacer()
            }
            .padding(.horizontal, Space.s2)
            .frame(height: Control.heightLg)
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
                        Image(systemName: "gearshape")
                            .font(.system(size: FontSize.sizeMd))
                            .frame(width: Control.heightMd, height: Control.heightMd)
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
                    Label(l10n("nav.sign_out"), systemImage: "rectangle.portrait.and.arrow.right")
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
                        Label(app.profileName(slug), systemImage: "checkmark")
                    } else {
                        Text(app.profileName(slug))
                    }
                }
            }
        } label: {
            HStack(spacing: Space.s2) {
                Image(systemName: "person.crop.square")
                Text(app.profileName(app.currentProfile))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if app.enterableProfiles.count > 1 {
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: FontSize.sizeXs))
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

enum Icons {
    static func symbol(for destination: DestinationID) -> String {
        switch destination {
        case .newChat: return "square.and.pencil"
        case .search: return "magnifyingglass"
        case .agentManager: return "cpu"
        case .tasks: return "checklist"
        case .schedules: return "calendar.badge.clock"
        case .chat: return "bubble.left.and.bubble.right"
        case .rooms: return "person.3"
        case .settings: return "gearshape"
        case .account: return "person.crop.circle"
        case .users: return "person.2"
        case .webhooks: return "link"
        case .display: return "textformat.size"
        case .notifications: return "bell"
        case .privacy: return "hand.raised"
        case .thisDevice: return "iphone"
        case .about: return "info.circle"
        case .models: return "square.stack.3d.up"
        case .deviceConnections: return "qrcode"
        case .knowledge: return "books.vertical"
        case .logs: return "doc.text.magnifyingglass"
        case .usage: return "chart.bar"
        case .skillsUsage: return "wand.and.stars.inverse"
        case .performance: return "speedometer"
        case .theme: return "paintpalette"
        case .workspaces: return "square.grid.2x2"
        case .updates: return "arrow.down.circle"
        case .plugins: return "puzzlepiece.extension"
        case .files: return "folder"
        case .agentSkills: return "wand.and.stars"
        case .agentMcp: return "server.rack"
        case .agentMemory: return "brain"
        case .agentJobs: return "clock.arrow.circlepath"
        case .agentChannels: return "bubble.left.and.text.bubble.right"
        case .agentPlugins: return "puzzlepiece"
        case .agentSettings: return "slider.horizontal.3"
        case .globalAgent: return "globe"
        }
    }
}
