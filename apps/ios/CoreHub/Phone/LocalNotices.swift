// Notices on this phone while the app runs. The hub writes a notice when a reply finishes or an
// agent waits for the person (the notify module, in the person's language) and announces it on
// `/rt/devices`; the app shows it as a local notification unless the person is already looking at
// that conversation. Push through APNs needs the hub's `devices` module (still 501) and the
// owner's Apple account, so nothing arrives while iOS has the app suspended (README.md).
import BackgroundTasks
import CoreHubClient
import Foundation
import UserNotifications

@MainActor
final class LocalNotices: NSObject, UNUserNotificationCenterDelegate {
    static let shared = LocalNotices()

    /// The conversation on screen: its notices stay quiet while the app is in front.
    var openSessionID: String?
    private weak var app: AppModel?
    private var listener: UUID?
    private var namespace: RealtimeNamespace?

    func start(app: AppModel) {
        self.app = app
        UNUserNotificationCenter.current().delegate = self
        let namespace = app.realtime.namespace("/rt/devices") { [weak app] in
            await app?.handshake(all: false) ?? [:]
        }
        self.namespace = namespace
        if let listener { namespace.remove(listener) }
        listener = namespace.onEvent { [weak self] name, argument in
            guard name == "notice.created", let envelope = Envelope.parse(argument),
                  let box = try? HubJSON.decoder.decode(NoticeBox.self, from: envelope.payload) else { return }
            self?.post(box.notice)
        }
    }

    func stop() {
        if let listener, let namespace { namespace.remove(listener) }
        listener = nil
        namespace = nil
    }

    /// Asks once; the answer is the system's.
    func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    func status() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// With the app closed: iOS wakes it now and then (`BGAppRefreshTask`, at most every 15
    /// minutes and when iOS decides); it reads the unread notices written since the last look and
    /// shows the new ones. Each notice is shown once, whichever path saw it first.
    func catchUp(app: AppModel) async {
        guard app.device.backgroundChecks, await app.keeper.credentials != nil else { return }
        let since = defaults.object(forKey: Keys.lastCheck) as? Date ?? Date().addingTimeInterval(-3600)
        let now = Date()
        guard let page = try? await app.api.call({
            try await NotifyAPI.notifyListNotices(unread: true, limit: 30, apiConfiguration: $0)
        }) else { return }
        for notice in page.items.reversed() where notice.createdAt > since { post(notice) }
        defaults.set(now, forKey: Keys.lastCheck)
    }

    private let defaults = UserDefaults.standard

    private enum Keys {
        static let posted = Product.storagePrefix + "notices.posted"
        static let lastCheck = Product.storagePrefix + "notices.last_check"
    }

    private func post(_ notice: Notice) {
        var posted = defaults.stringArray(forKey: Keys.posted) ?? []
        guard NoticeRouting.isNew(notice.id, posted: posted) else { return }
        posted = NoticeRouting.remember(notice.id, in: posted)
        defaults.set(posted, forKey: Keys.posted)
        let content = UNMutableNotificationContent()
        content.title = notice.title
        if let body = notice.body { content.body = body }
        content.sound = .default
        content.userInfo = NoticeRouting.userInfo(for: notice)
        let request = UNNotificationRequest(identifier: notice.id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }

    private struct NoticeBox: Decodable {
        let notice: Notice
    }

    // MARK: - UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let session = notification.request.content.userInfo[NoticeRouting.sessionKey] as? String
        Task { @MainActor in
            let quiet = session != nil && session == LocalNotices.shared.openSessionID
            completionHandler(quiet ? [] : [.banner, .list, .sound])
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let session = info[NoticeRouting.sessionKey] as? String
        let profile = info[NoticeRouting.profileKey] as? String
        let kind = info[NoticeRouting.kindKey] as? String
        Task { @MainActor in
            if let app = LocalNotices.shared.app {
                app.pendingRoute = NoticeRouting.route(kind: kind, sessionID: session, profile: profile, selector: app.currentProfile)
            }
            completionHandler()
        }
    }
}

/// Where a notice leads, kept in the notification so a tap can open it. Pure, tested.
enum NoticeRouting {
    static let sessionKey = "session_id"
    static let profileKey = "profile"
    static let kindKey = "resource_kind"

    static func userInfo(for notice: Notice) -> [String: String] {
        var info: [String: String] = [:]
        if let profile = notice.profile { info[profileKey] = profile }
        if let resource = notice.resource {
            info[kindKey] = resource.kind.rawValue
            if resource.kind == .session { info[sessionKey] = resource.id }
        }
        return info
    }

    /// Whether a notice has not been shown yet.
    static func isNew(_ id: String, posted: [String]) -> Bool { !posted.contains(id) }

    /// The ids already shown, newest last, kept to the last 300.
    static func remember(_ id: String, in posted: [String]) -> [String] {
        Array((posted + [id]).suffix(300))
    }

    static func route(kind: String?, sessionID: String?, profile: String?, selector: String) -> MainContent? {
        if let sessionID { return .chat(sessionID: sessionID, profile: profile ?? selector) }
        switch kind {
        case "task", "subtask", "project", "worktree": return .destination(.tasks)
        case "schedule", "schedule_run", "workflow", "workflow_run", "step": return .destination(.schedules)
        case "agent": return .destination(.agentManager)
        default: return nil
        }
    }
}

/// The background look at the hub's notices (Info.plist `BGTaskSchedulerPermittedIdentifiers`).
enum NoticeRefresh {
    static let identifier = "io.github.twuijri.corehub.notices"

    /// Asks iOS to wake the app in about 15 minutes; iOS decides when, or whether.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date().addingTimeInterval(15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}
