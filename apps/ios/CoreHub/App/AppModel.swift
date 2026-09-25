// The app's one source of truth for who is signed in, to which hub, in which profile, in which
// language and theme. Screens read it from the environment; nothing here decides a business
// rule — the hub does (NAVIGATION.md rule 5).
import CoreHubClient
import Foundation
import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case launching
        case signedOut
        case signedIn
    }

    var phase: Phase = .launching
    var language: AppLanguage {
        didSet {
            l10n = L10n(language)
            api.language = language
            defaults.set(language.rawValue, forKey: Keys.language)
        }
    }

    var theme: ThemeChoice {
        didSet { defaults.set(theme.rawValue, forKey: Keys.theme) }
    }

    private(set) var l10n: L10n
    private(set) var credentials: Credentials?
    /// Every profile the person may enter, in the hub's order.
    private(set) var profiles: [Profile] = []
    /// The profile selector: always one concrete profile (profileScope.selector). New chats
    /// are made in it; it never filters a list.
    private(set) var currentProfile: String = "default"
    /// The agents of the current profile, from the hub's registry.
    private(set) var agents: [Agent] = []
    private(set) var connection: RealtimeClient.State = .offline
    /// Why the last sign-out happened, shown once on the sign-in screen.
    var notice: String?
    /// Where a `corehub://open/…` link asked to go; the shell takes it.
    var pendingRoute: MainContent?

    let keeper: TokenKeeper
    let api: HubAPI
    let realtime: RealtimeClient
    /// This phone's own voice and reading choices («This device»).
    let device = DeviceSettings()
    /// Text shared from another app, waiting to become a new chat.
    var pendingDraft: String?
    private let defaults: UserDefaults
    @ObservationIgnored private var sessionsNamespace: RealtimeNamespace?
    /// A link that opened the app before it knew whether anyone was signed in.
    @ObservationIgnored private var pendingLink: URL?

    enum Keys {
        static let language = Product.storagePrefix + "language"
        static let theme = Product.storagePrefix + "theme"
        static let profile = Product.storagePrefix + "profile"
    }

    init(defaults: UserDefaults = .standard, keeper: TokenKeeper = TokenKeeper()) {
        self.defaults = defaults
        self.keeper = keeper
        let language = defaults.string(forKey: Keys.language).flatMap(AppLanguage.init(rawValue:)) ?? .preferred
        self.language = language
        self.theme = defaults.string(forKey: Keys.theme).flatMap(ThemeChoice.init(rawValue:)) ?? .system
        self.l10n = L10n(language)
        self.api = HubAPI(keeper: keeper)
        self.realtime = RealtimeClient(keeper: keeper)
        api.language = language
        realtime.onStateChange = { [weak self] state in self?.connection = state }
    }

    var isAdmin: Bool {
        credentials?.role == Role.owner.rawValue || credentials?.role == Role.admin.rawValue
    }

    /// Profiles the person may enter, by slug.
    var enterableProfiles: [String] { credentials?.profiles ?? [] }

    func profileName(_ slug: String) -> String {
        profiles.first { $0.slug == slug }?.name ?? slug
    }

    var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    // MARK: - Launch and sign-in

    func launch() async {
        await keeper.onSignedOut { [weak self] in self?.signedOutByHub() }
        await keeper.setLanguage(language)
        #if DEBUG
        if DemoHub.isOn {
            await launchDemo()
            return
        }
        #endif
        guard let stored = await keeper.credentials else {
            phase = .signedOut
            if let link = pendingLink {
                pendingLink = nil
                open(link)
            }
            return
        }
        pendingLink = nil
        credentials = stored
        enterSignedIn()
        if stored.needsRenewal() { _ = await keeper.refresh() }
        await refreshAccount()
        await PushCenter.shared.start(app: self)
    }

    #if DEBUG
    /// Screenshots and UI tests (`-UITestDemo YES`, DemoHub.swift): signed in to the demo hub at
    /// once, with no socket, no push and no notices; `-UITestDemoOpen <path>` opens a page.
    private func launchDemo() async {
        let demo = DemoHub.credentials()
        await keeper.set(demo)
        credentials = demo
        currentProfile = AppModel.pickProfile(remembered: nil, credentials: demo)
        connection = .connected
        phase = .signedIn
        await refreshAccount()
        if let path = DemoHub.openPath, let url = URL(string: "\(Product.id)://open\(path)") {
            pendingRoute = AppModel.route(for: url, selector: currentProfile)
        }
    }
    #endif

    /// Username and password against the hub at `hub`.
    func signIn(hub: URL, username: String, password: String) async throws {
        let meta = try await api.anonymous(hub: hub) { try await MetaAPI.metaGet(apiConfiguration: $0) }
        if meta.setupRequired { throw SignInProblem.setupRequired(open: meta.setupOpen) }
        let pair = try await api.anonymous(hub: hub) {
            try await AuthAPI.authLogin(
                loginRequest: LoginRequest(username: username, password: password),
                acceptLanguage: AuthAPI.AcceptLanguage_authLogin(rawValue: self.language.rawValue),
                apiConfiguration: $0
            )
        }
        let credentials = Credentials(
            hubURL: hub,
            kind: .password,
            accessToken: pair.accessToken,
            refreshToken: pair.refreshToken,
            accessExpiresAt: Date().addingTimeInterval(TimeInterval(pair.expiresIn)),
            renewedAt: nil,
            userID: pair.user.id,
            username: pair.user.username,
            displayName: pair.user.displayName,
            role: pair.user.role.rawValue,
            profiles: pair.user.profiles,
            defaultProfile: pair.user.defaultProfile
        )
        await finishSignIn(credentials)
    }

    /// First-run setup (preAuth `setup`, ADR 0011/0019): makes the owner and signs them in.
    func completeSetup(hub: URL, username: String, password: String, displayName: String?, token: String?) async throws {
        let request = SetupRequest(token: token, username: username, password: password, displayName: displayName)
        let pair = try await api.anonymous(hub: hub) {
            try await AuthAPI.authCompleteSetup(
                setupRequest: request,
                acceptLanguage: AuthAPI.AcceptLanguage_authCompleteSetup(rawValue: self.language.rawValue),
                apiConfiguration: $0
            )
        }
        await finishSignIn(Credentials(
            hubURL: hub,
            kind: .password,
            accessToken: pair.accessToken,
            refreshToken: pair.refreshToken,
            accessExpiresAt: Date().addingTimeInterval(TimeInterval(pair.expiresIn)),
            renewedAt: nil,
            userID: pair.user.id,
            username: pair.user.username,
            displayName: pair.user.displayName,
            role: pair.user.role.rawValue,
            profiles: pair.user.profiles,
            defaultProfile: pair.user.defaultProfile
        ))
    }

    /// How this phone describes itself to the hub: pairing and `devices.register` alike.
    func thisDevice() -> DeviceRegistration {
        let device = UIDevice.current
        return DeviceRegistration(
            deviceKey: DeviceKey.current(defaults: defaults),
            name: device.name,
            platform: .ios,
            kind: device.userInterfaceIdiom == .pad ? .tablet : .phone,
            brand: "Apple",
            model: device.model,
            appVersion: appVersion,
            capabilities: [.camera, .microphone, .notifications, .clipboard]
        )
    }

    /// Claims a pairing the web made (Settings → Device connections → App).
    func pair(_ payload: PairingPayload) async throws {
        let registration = thisDevice()
        let result = try await api.anonymous(hub: payload.hubURL) {
            try await AuthAPI.authClaimPairing(
                pairingId: payload.pairingID,
                pairingClaim: PairingClaim(code: payload.code, device: registration),
                apiConfiguration: $0
            )
        }
        let credentials = Credentials(
            hubURL: payload.hubURL,
            kind: .device,
            accessToken: result.appToken,
            refreshToken: nil,
            accessExpiresAt: nil,
            renewedAt: Date(),
            userID: result.user.id,
            username: result.user.username,
            displayName: result.user.displayName,
            role: result.user.role.rawValue,
            profiles: result.user.profiles,
            defaultProfile: result.user.defaultProfile,
            deviceID: result.device.id
        )
        await finishSignIn(credentials)
    }

    private func finishSignIn(_ credentials: Credentials) async {
        await keeper.set(credentials)
        self.credentials = credentials
        notice = nil
        enterSignedIn()
        await refreshAccount()
        // Asks for notifications (in front, once a launch, while iOS has not asked yet); with a
        // yes, the phone registers for push with the hub.
        await PushCenter.shared.start(app: self)
    }

    private func enterSignedIn() {
        guard let credentials else { return }
        let remembered = defaults.string(forKey: Keys.profile)
        currentProfile = AppModel.pickProfile(remembered: remembered, credentials: credentials)
        phase = .signedIn
        realtime.start(hub: credentials.hubURL)
        sessionsNamespace = realtime.namespace("/rt/sessions") { [weak self] in
            await self?.handshake(all: true) ?? [:]
        }
        LocalNotices.shared.start(app: self)
        takeShared()
    }

    /// Text the share extension left for the app becomes a new chat's draft.
    func takeShared() {
        if let text = ShareInbox.take(from: ShareInbox.defaults()) { pendingDraft = text }
    }

    /// The profile the app opens on: the one used last if still allowed, else the person's
    /// default if allowed, else the first they may enter.
    nonisolated static func pickProfile(remembered: String?, credentials: Credentials) -> String {
        let allowed = credentials.profiles
        if let remembered, allowed.contains(remembered) { return remembered }
        if allowed.contains(credentials.defaultProfile) { return credentials.defaultProfile }
        return allowed.first ?? credentials.defaultProfile
    }

    /// The realtime handshake (events/README.md): the bearer, the selector's profile, and
    /// `profiles: 'all'` where a list gathers every profile.
    func handshake(all: Bool) async -> [String: Any] {
        var auth: [String: Any] = ["profile": currentProfile]
        if let token = await keeper.bearer() { auth["token"] = token }
        if all { auth["profiles"] = "all" }
        return auth
    }

    /// `/rt/sessions`, heard across every profile the person may enter.
    var sessions: RealtimeNamespace? { sessionsNamespace }

    /// Re-reads who the person is, the profiles and the agents.
    func refreshAccount() async {
        do {
            let me = try await api.call { try await AuthAPI.authGetMe(apiConfiguration: $0) }
            await keeper.updateAccount(me)
            credentials = await keeper.credentials
            if let credentials, !credentials.profiles.contains(currentProfile) {
                currentProfile = AppModel.pickProfile(remembered: nil, credentials: credentials)
            }
            let list = try await api.call { try await AuthAPI.authListProfiles(apiConfiguration: $0) }
            let allowed = Set(credentials?.profiles ?? [])
            profiles = list.items.filter { allowed.contains($0.slug) }
        } catch {
            // The chat list says what failed; the shell keeps what it had.
        }
        await reloadAgents()
    }

    func reloadAgents() async {
        let profile = currentProfile
        do {
            let list = try await api.call { try await AgentsAPI.agentsList(xHubProfile: profile, apiConfiguration: $0) }
            if profile == currentProfile { agents = list.items }
        } catch {
            if profile == currentProfile { agents = [] }
        }
    }

    /// The selector: switches `X-Hub-Profile` for what is made next and refetches; never moves
    /// the screen (NAVIGATION.md rule 4).
    func switchProfile(_ slug: String) {
        guard slug != currentProfile, enterableProfiles.contains(slug) else { return }
        currentProfile = slug
        defaults.set(slug, forKey: Keys.profile)
        if let sessionsNamespace { sessionsNamespace.reconnect() }
        Task { await reloadAgents() }
    }

    func signOut() async {
        if credentials != nil {
            // Push first, while the token still works, so the hub stops pushing to this phone.
            let deviceID = await keeper.credentials?.deviceID
            await PushCenter.shared.signOut(deviceID: deviceID)
            _ = try? await api.call { try await AuthAPI.authLogout(apiConfiguration: $0) }
        }
        await clearSession()
    }

    private func signedOutByHub() {
        notice = l10n("errors.signed_out")
        Task { await clearSession() }
    }

    private func clearSession() async {
        LocalNotices.shared.stop()
        PushCenter.shared.reset()
        Speaker.shared.stop()
        realtime.stop()
        sessionsNamespace = nil
        await keeper.set(nil)
        credentials = nil
        profiles = []
        agents = []
        phase = .signedOut
    }

    /// A `corehub://` link opened the app. Signed out, a `pair` link pairs this phone; the
    /// sentence of a refusal lands on the sign-in screen.
    func open(_ url: URL) {
        if phase == .launching {
            pendingLink = url
            return
        }
        if phase == .signedIn {
            pendingRoute = AppModel.route(for: url, selector: currentProfile)
            return
        }
        switch PairingPayload.parseLink(url.absoluteString) {
        case .success(let payload):
            Task {
                do {
                    try await pair(payload)
                } catch {
                    notice = HubFailure(error).describe(l10n)
                }
            }
        case .failure:
            notice = l10n("login.pairing_invalid")
        }
    }

    /// `corehub://open/<path>` → the page it names (the paths of `surfaceRoutes.ios`). A chat
    /// opens in the profile its `?profile=` names, else the selector's.
    nonisolated static func route(for url: URL, selector: String) -> MainContent? {
        guard url.scheme?.lowercased() == Product.id,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let action = components.host ?? ""
        guard action == "open" else { return nil }
        guard let match = AppRoutes.match(components.path) else { return nil }
        let destination = match.destination
        let params = match.params
        switch destination {
        case .chat:
            guard let id = params["sessionId"] else { return .newChat }
            let profile = components.queryItems?.first { $0.name == "profile" }?.value ?? selector
            return .chat(sessionID: id, profile: profile)
        case .newChat:
            return .newChat
        case .settings:
            return .settings
        default:
            if NavigationMap.settingsTabs.contains(destination) || NavigationMap.settingsManagement.contains(destination)
                || NavigationMap.settingsTools.contains(destination) { return .settings }
            if NavigationMap.agentLevel.contains(destination) { return .destination(.agentManager) }
            return .destination(destination)
        }
    }

    /// Foreground again: reconnect now and renew a device token that is due.
    func becameActive() {
        guard phase == .signedIn else { return }
        #if DEBUG
        if DemoHub.isOn { return }
        #endif
        realtime.resume()
        takeShared()
        Task {
            if let stored = await keeper.credentials, stored.needsRenewal() { _ = await keeper.refresh() }
            // Not asked yet, turned on in Settings, or the hub has a sender now: try again.
            await PushCenter.shared.foreground(app: self)
        }
    }
}

enum SignInProblem: Error {
    /// The hub has no owner yet; `open` when setup needs no claim token right now.
    case setupRequired(open: Bool)
}
