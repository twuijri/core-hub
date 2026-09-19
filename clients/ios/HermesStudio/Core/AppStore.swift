import Foundation
import SwiftUI

@MainActor
final class AppStore: ObservableObject {
    @Published var phase: Phase = .launching
    @Published var baseURL = Preferences.baseURL
    @Published var token = AppSessionRecord.load()?.token ?? SecureStore.get("token")
    @Published var currentUser: CurrentUser?
    @Published var profiles: [Profile] = []
    @Published var selectedProfile = Preferences.profile
    @Published var language = Preferences.language
    @Published private(set) var languageRefresh = 0
    @Published private(set) var languageTransitioning = false
    @Published var appearance = Preferences.appearance
    @Published var reasoningEffort = Preferences.reasoningEffort
    @Published var voiceInput = Preferences.voiceInput
    @Published var showToolCalls = Preferences.showToolCalls
    @Published var autoSpeakReplies = Preferences.autoSpeakReplies
    @Published var allProfilesSessions = Preferences.allProfilesSessions
    @Published var textScale = Preferences.textScale
    @Published var errorMessage: String?
    @Published var successMessage: String?
    @Published var busy = false

    // MARK: Shell navigation (M2: drawer + conversation switch, like the web)

    @Published var drawerOpen = false
    @Published var drawerPage: DrawerPage = .navigation
    @Published var conversationMode: ConversationMode = .chat
    @Published var selectedSession: SessionSummary?
    @Published var selectedRoom: Room?
    @Published var selectedWorkflow: WorkflowItem?
    @Published var shellDestination: ShellDestination?
    /// Room sheets requested from the drawer (create / join by code).
    @Published var roomAction: RoomAction?
    /// Bumped whenever a session is created, renamed, archived or deleted so
    /// the drawer list reloads.
    @Published private(set) var sessionListVersion = 0
    /// Default model for new conversations (drawer footer model selector).
    @Published var preferredModel = Preferences.preferredModel
    @Published private(set) var serverVersion = ""
    @Published private(set) var connected = false
    let browserPrefs = SessionBrowserPrefs()

    /// Present only for QR-paired (app-login) connections.
    @Published private(set) var appSession: AppSessionRecord? = AppSessionRecord.load()

    private var languageRefreshTask: Task<Void, Never>?
    private var refreshTask: Task<String?, Never>?

    let api: APIClient

    enum Phase { case launching, signedOut, signedIn }
    enum RoomAction: String, Identifiable { case create, join; var id: String { rawValue } }
    enum DrawerPage { case navigation, settings }

    var isSuperAdmin: Bool { currentUser?.isSuperAdmin == true }

    init() {
        api = APIClient(baseURL: Preferences.baseURL, token: "")
        api.update(baseURL: baseURL, token: token)
        api.activeProfile = selectedProfile
        CoreHubTokens.Typography.scale = CGFloat(textScale)
        api.tokenRefresher = { [weak self] in
            guard let self else { return nil }
            return await self.refreshAppToken(force: true)
        }
    }

    var locale: Locale {
        language == "ar" ? Locale(identifier: "ar") : (language == "en" ? Locale(identifier: "en") : .autoupdatingCurrent)
    }
    var layoutDirection: LayoutDirection { locale.language.languageCode?.identifier == "ar" ? .rightToLeft : .leftToRight }
    var preferredColorScheme: ColorScheme? { appearance == "dark" ? .dark : (appearance == "light" ? .light : nil) }
    var profile: Profile? { profiles.first { $0.name == selectedProfile } }
    var isConfigured: Bool { !baseURL.isEmpty && !token.isEmpty }
    /// BCP-47 locale used for on-device speech recognition.
    var speechLocaleIdentifier: String {
        if language == "ar" { return "ar-SA" }
        if language == "en" { return "en-US" }
        return Locale.autoupdatingCurrent.identifier
    }
    /// Two-letter language hint sent to the server transcription endpoint.
    var speechLanguageHint: String? {
        if language == "ar" || language == "en" { return language }
        return Locale.autoupdatingCurrent.language.languageCode?.identifier
    }

    func boot() async {
        await StudioLogoStore.shared.loadCached()
        guard isConfigured else { phase = .signedOut; return }
        api.update(baseURL: baseURL, token: token)
        if let session = appSession, session.needsRefresh() {
            _ = await refreshAppToken(force: true)
            // A 401 during refresh already signed the user out with a message.
            if phase == .signedOut { return }
        }
        do {
            // `/auth/me` is the authoritative credential check. A secondary
            // profile request must not turn a valid signed-in user into a login
            // screen during an update or a brief Studio restart.
            currentUser = try await api.currentUser()
            phase = .signedIn
            do {
                profiles = try await api.profiles()
            } catch {
                errorMessage = error.localizedDescription
            }
            selectProfileIfNeeded()
            await StudioLogoStore.shared.sync(from: api)
        } catch {
            // A development reinstall, a server restart, or one transient 401
            // must not destructively erase a valid Keychain credential. Only an
            // explicit Sign Out or a successful replacement login removes it.
            // This also lets the next launch retry without asking for the token.
            if case HermesError.http(401, _) = error {
                phase = .signedOut
            } else {
                // Keep the signed-in shell and the Keychain token on transient
                // connectivity failures. Lists can be refreshed after Studio
                // comes back instead of asking for credentials again.
                errorMessage = error.localizedDescription
                phase = .signedIn
            }
        }
    }

    func login(server: String, username: String, password: String) async {
        busy = true; errorMessage = nil
        var normalized = server.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalized.contains("://") { normalized = "https://" + normalized }
        normalized = normalized.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        api.update(baseURL: normalized, token: "")
        do {
            let issued = try await api.login(username: username, password: password)
            AppSessionRecord.clear(); appSession = nil
            baseURL = normalized; token = issued
            Preferences.baseURL = normalized; SecureStore.set(issued, for: "token")
            api.update(baseURL: normalized, token: issued)
            currentUser = try await api.currentUser()
            profiles = try await api.profiles()
            selectProfileIfNeeded()
            phase = .signedIn
            await StudioLogoStore.shared.sync(from: api)
        } catch {
            errorMessage = error.localizedDescription
            api.update(baseURL: baseURL, token: token)
        }
        busy = false
    }

    /// Pairs this iPhone with the Core Hub server encoded in a scanned QR code
    /// (`POST /api/auth/app-login`).
    func pair(with qr: AppConnectionQR, deviceName: String) async {
        busy = true; errorMessage = nil
        defer { busy = false }
        if qr.isExpired() {
            errorMessage = Self.pairingErrorMessage(HermesError.http(410, ""))
            return
        }
        let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? DeviceIdentity.defaultName
        let deviceCode = DeviceIdentity.deviceCode
        api.update(baseURL: qr.backendURL, token: "")
        let record: AppSessionRecord
        do {
            let response = try await api.appLogin(
                authorizationCode: qr.authorizationCode,
                deviceCode: deviceCode,
                deviceName: name,
                deviceModel: DeviceIdentity.modelIdentifier
            )
            record = AppSessionRecord(
                token: response.token,
                tokenExpiresAt: response.tokenExpiresAt,
                connectionID: response.connectionID,
                deviceCode: deviceCode,
                lastRefresh: Date()
            )
            try record.save()
        } catch {
            errorMessage = Self.pairingErrorMessage(error)
            api.update(baseURL: baseURL, token: token)
            return
        }
        SecureStore.remove("token")
        appSession = record
        baseURL = qr.backendURL; token = record.token
        Preferences.baseURL = qr.backendURL
        api.update(baseURL: qr.backendURL, token: record.token)
        do {
            currentUser = try await api.currentUser()
            profiles = try await api.profiles()
        } catch {
            errorMessage = error.localizedDescription
        }
        selectProfileIfNeeded()
        phase = .signedIn
        await StudioLogoStore.shared.sync(from: api)
        notify(String(localized: "Paired with Core Hub"))
    }

    /// Maps `POST /api/auth/app-login` status codes to readable messages.
    static func pairingErrorMessage(_ error: Error) -> String {
        guard case let HermesError.http(status, detail) = error else { return error.localizedDescription }
        switch status {
        case 400:
            let base = String(localized: "Core Hub rejected the pairing request because a required field is missing.")
            return detail.isEmpty ? base : "\(base) (\(detail))"
        case 401: return String(localized: "The pairing code is invalid. Create a new one in Core Hub and scan it again.")
        case 403: return String(localized: "The user who created this pairing code is disabled. Ask the Core Hub owner to enable the account.")
        case 409: return String(localized: "This pairing code has already been used. Create a new one in Core Hub.")
        case 410: return String(localized: "This pairing code has expired. Create a new one in Core Hub and scan it again.")
        default: return error.localizedDescription
        }
    }

    /// Silently refreshes the app-connection token (`POST /api/auth/app-refresh`).
    /// Concurrent callers share one in-flight request. Returns the new token,
    /// or `nil` when nothing was refreshed. A 401 signs the user out.
    func refreshAppToken(force: Bool) async -> String? {
        guard let current = appSession else { return nil }
        if !force && !current.needsRefresh() { return nil }
        if let running = refreshTask { return await running.value }
        let task = Task<String?, Never> { [weak self] in
            guard let self else { return nil }
            do {
                let response = try await self.api.appRefresh()
                var record = current
                record.token = response.token
                record.tokenExpiresAt = response.tokenExpiresAt ?? record.tokenExpiresAt
                if response.connectionID > 0 { record.connectionID = response.connectionID }
                record.lastRefresh = Date()
                try record.save()
                self.appSession = record
                self.token = response.token
                self.api.update(baseURL: self.baseURL, token: response.token)
                return response.token
            } catch {
                if case HermesError.http(401, _) = error {
                    self.signOut(message: String(localized: "This iPhone's link to Core Hub has expired or was removed. Scan the pairing QR code again."))
                } else if let expiresAt = current.tokenExpiresAt, expiresAt <= Date() {
                    // The token is already dead and the refresh did not work:
                    // the user must know why every request fails now.
                    self.errorMessage = String(localized: "The Core Hub session could not be refreshed: \(error.localizedDescription)")
                }
                return nil
            }
        }
        refreshTask = task
        let result = await task.value
        refreshTask = nil
        return result
    }

    func refreshProfiles() async {
        do { profiles = try await api.profiles(); selectProfileIfNeeded() }
        catch { errorMessage = error.localizedDescription }
    }

    func chooseProfile(_ name: String) {
        selectedProfile = name; Preferences.profile = name; api.activeProfile = name
    }

    func setPreferredModel(_ model: String) { preferredModel = model; Preferences.preferredModel = model }

    func signOut(message: String? = nil) {
        SecureStore.remove("token"); AppSessionRecord.clear(); appSession = nil
        token = ""; currentUser = nil; profiles = []; phase = .signedOut
        api.update(baseURL: baseURL, token: "")
        selectedSession = nil; selectedRoom = nil; selectedWorkflow = nil; shellDestination = nil
        drawerOpen = false; drawerPage = .navigation; conversationMode = .chat
        connected = false
        if let message { errorMessage = message }
    }

    // MARK: Shell helpers

    /// `GET /health`: connection dot and "Core Hub v{version}" in the drawer.
    func checkHealth() async {
        do {
            let status = try await api.health()
            connected = status.ok
            if !status.webUIVersion.isEmpty { serverVersion = status.webUIVersion }
        } catch {
            connected = false
        }
    }

    func sessionsChanged() { sessionListVersion &+= 1 }

    /// Opens a local, not-yet-persisted conversation (web "New Chat").
    func startNewChat(agent: String = "hermes") {
        open(SessionSummary.draft(agent: agent, profile: selectedProfile, model: preferredModel))
    }

    func open(_ session: SessionSummary) {
        shellDestination = nil
        conversationMode = .chat
        selectedSession = session
        browserPrefs.markRead(session.id)
        drawerOpen = false
    }

    func open(_ room: Room) {
        shellDestination = nil
        conversationMode = .group
        selectedRoom = room
        drawerOpen = false
    }

    /// Rooms changed (created, renamed, deleted): the drawer list reloads.
    func roomsChanged() { sessionListVersion &+= 1 }

    func open(_ workflow: WorkflowItem) {
        shellDestination = nil
        conversationMode = .workflow
        selectedWorkflow = workflow
        drawerOpen = false
    }

    /// Opens the drawer. The keyboard goes with it: a focused composer
    /// otherwise keeps the keyboard over the drawer's lower half. Focus is
    /// dropped as part of the same transition, without a delay.
    func openDrawer(page: DrawerPage = .navigation) {
        Keyboard.dismiss()
        drawerPage = page
        drawerOpen = true
    }

    func show(_ destination: ShellDestination) {
        drawerOpen = false
        drawerPage = .navigation
        shellDestination = destination
    }

    func switchMode(_ mode: ConversationMode) {
        conversationMode = mode
        shellDestination = nil
        if mode == .history { drawerOpen = false }
    }

    func updateServer(_ server: String) async {
        var normalized = server.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalized.contains("://") { normalized = "https://" + normalized }
        normalized = normalized.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        baseURL = normalized; Preferences.baseURL = normalized; api.update(baseURL: normalized, token: token)
        await boot()
    }

    func setLanguage(_ value: String) {
        languageRefreshTask?.cancel()
        guard value != language else {
            languageTransitioning = false
            return
        }
        languageTransitioning = true

        // UIKit-backed SwiftUI lists keep their previous mirror transform for
        // more than one render pass. First fade in a neutral cover, then change
        // direction behind it and rebuild every cached root list. The cover
        // fades out only after the new direction has settled everywhere.
        languageRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(110))
            guard !Task.isCancelled, let self else { return }
            self.language = value
            Preferences.language = value
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            self.languageRefresh &+= 1
            try? await Task.sleep(for: .milliseconds(50))
            guard !Task.isCancelled else { return }
            self.languageTransitioning = false
        }
    }
    func setAppearance(_ value: String) { appearance = value; Preferences.appearance = value }
    func setReasoning(_ value: String) { reasoningEffort = value; Preferences.reasoningEffort = value }
    func setVoiceInput(_ value: String) { voiceInput = value; Preferences.voiceInput = value }
    func setShowToolCalls(_ value: Bool) { showToolCalls = value; Preferences.showToolCalls = value }
    func setAutoSpeakReplies(_ value: Bool) { autoSpeakReplies = value; Preferences.autoSpeakReplies = value }
    func setAllProfilesSessions(_ value: Bool) { allProfilesSessions = value; Preferences.allProfilesSessions = value; sessionsChanged() }
    func setTextScale(_ value: Double) {
        let clamped = min(1.45, max(0.85, value))
        textScale = clamped
        Preferences.textScale = clamped
        CoreHubTokens.Typography.scale = CGFloat(clamped)
        // Token fonts are computed, not observed: rebuild the shell so every
        // cached row picks up the new size.
        languageRefresh &+= 1
    }
    /// Profile filter for session lists: `nil` = every profile.
    var sessionListProfile: String? { allProfilesSessions ? nil : selectedProfile.nilIfEmpty }

    func notify(_ text: String) { successMessage = text; Task { try? await Task.sleep(for: .seconds(2)); if self.successMessage == text { self.successMessage = nil } } }

    /// Runs a network call and surfaces any failure in the error banner.
    /// Use instead of `try?` for calls whose result feeds the UI.
    @discardableResult
    func attempt<T>(_ work: () async throws -> T) async -> T? {
        do { return try await work() }
        catch { errorMessage = error.localizedDescription; return nil }
    }

    private func selectProfileIfNeeded() {
        defer { api.activeProfile = selectedProfile }
        if profiles.contains(where: { $0.name == selectedProfile }) { return }
        selectedProfile = profiles.first(where: \.active)?.name ?? profiles.first?.name ?? "default"
        Preferences.profile = selectedProfile
    }
}
