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

    let keeper: TokenKeeper
    let api: HubAPI
    let realtime: RealtimeClient
    private let defaults: UserDefaults
    @ObservationIgnored private var sessionsNamespace: RealtimeNamespace?

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
        guard let stored = await keeper.credentials else {
            phase = .signedOut
            return
        }
        credentials = stored
        enterSignedIn()
        if stored.needsRenewal() { _ = await keeper.refresh() }
        await refreshAccount()
    }

    /// Username and password against the hub at `hub`.
    func signIn(hub: URL, username: String, password: String) async throws {
        let meta = try await api.anonymous(hub: hub) { try await MetaAPI.metaGet(apiConfiguration: $0) }
        if meta.setupRequired { throw SignInProblem.setupRequired }
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

    /// Claims a pairing the web made (Settings → Device connections → App).
    func pair(_ payload: PairingPayload) async throws {
        let device = UIDevice.current
        let registration = DeviceRegistration(
            deviceKey: DeviceKey.current(defaults: defaults),
            name: device.name,
            platform: .ios,
            kind: device.userInterfaceIdiom == .pad ? .tablet : .phone,
            brand: "Apple",
            model: device.model,
            appVersion: appVersion,
            capabilities: [.camera, .microphone, .notifications, .clipboard]
        )
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
            defaultProfile: result.user.defaultProfile
        )
        await finishSignIn(credentials)
    }

    private func finishSignIn(_ credentials: Credentials) async {
        await keeper.set(credentials)
        self.credentials = credentials
        notice = nil
        enterSignedIn()
        await refreshAccount()
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
            _ = try? await api.call { try await AuthAPI.authLogout(apiConfiguration: $0) }
        }
        await clearSession()
    }

    private func signedOutByHub() {
        notice = l10n("errors.signed_out")
        Task { await clearSession() }
    }

    private func clearSession() async {
        realtime.stop()
        sessionsNamespace = nil
        await keeper.set(nil)
        credentials = nil
        profiles = []
        agents = []
        phase = .signedOut
    }

    /// Foreground again: reconnect now and renew a device token that is due.
    func becameActive() {
        guard phase == .signedIn else { return }
        realtime.resume()
        Task {
            if let stored = await keeper.credentials, stored.needsRenewal() { _ = await keeper.refresh() }
        }
    }
}

enum SignInProblem: Error {
    case setupRequired
}
