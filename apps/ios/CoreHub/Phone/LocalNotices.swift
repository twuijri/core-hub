// Notices on this phone while the app runs. The hub writes a notice when a reply finishes or an
// agent waits for the person (the notify module, in the person's language) and announces it on
// `/rt/devices`; the app shows it as a local notification unless the person is already looking at
// that conversation. With the app suspended, the hub's APNs push carries it (Push.swift); without
// push, iOS wakes the app now and then to look (`NoticeRefresh`). Local and pushed notices share
// one list of what was shown, so a notice is shown once whichever path saw it first.
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

    /// A tap that launched the app before anyone was known to be signed in.
    private var pendingTap: NoticeRouting.Tap?

    func start(app: AppModel) {
        self.app = app
        UNUserNotificationCenter.current().delegate = self
        if let tap = pendingTap {
            pendingTap = nil
            follow(tap, app: app)
        }
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
        guard app.device.backgroundChecks, !PushCenter.shared.isActive,
              await app.keeper.credentials != nil else { return }
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

    /// True the first time a notice id is seen, by the socket, the background look or a push.
    func claim(_ id: String) -> Bool {
        var posted = defaults.stringArray(forKey: Keys.posted) ?? []
        guard NoticeRouting.isNew(id, posted: posted) else { return false }
        posted = NoticeRouting.remember(id, in: posted)
        defaults.set(posted, forKey: Keys.posted)
        return true
    }

    private func follow(_ tap: NoticeRouting.Tap, app: AppModel) {
        app.pendingRoute = NoticeRouting.route(kind: tap.kind, sessionID: tap.sessionID, profile: tap.profile, selector: app.currentProfile)
    }

    private func post(_ notice: Notice) {
        guard claim(notice.id) else { return }
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

    /// In front: a notice about the conversation on screen stays quiet, and a push for a notice
    /// the socket already showed is not shown again.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let tap = NoticeRouting.tap(from: notification.request.content.userInfo)
        let pushed = notification.request.trigger is UNPushNotificationTrigger
        Task { @MainActor in
            let shownAlready = pushed && tap.noticeID.map { !LocalNotices.shared.claim($0) } == true
            let quiet = shownAlready || (tap.sessionID != nil && tap.sessionID == LocalNotices.shared.openSessionID)
            completionHandler(quiet ? [] : [.banner, .list, .sound])
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // A local notice keeps flat keys; a push carries the hub's payload (`resource`, `profile`).
        let tap = NoticeRouting.tap(from: response.notification.request.content.userInfo)
        Task { @MainActor in
            let notices = LocalNotices.shared
            if let app = notices.app, app.phase == .signedIn {
                notices.follow(tap, app: app)
            } else {
                notices.pendingTap = tap
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
    static let noticeKey = "notice_id"

    /// What a tapped or arriving notification says about its notice.
    struct Tap: Equatable {
        var kind: String?
        var sessionID: String?
        var profile: String?
        var noticeID: String?
    }

    /// Reads both shapes: a local notice's flat keys (`userInfo(for:)`) and the hub's push
    /// payload beside `aps` (`notice_id`, `profile`, `resource: { kind, id }`).
    static func tap(from info: [AnyHashable: Any]) -> Tap {
        var tap = Tap(
            kind: info[kindKey] as? String,
            sessionID: info[sessionKey] as? String,
            profile: info[profileKey] as? String,
            noticeID: info[noticeKey] as? String
        )
        if let resource = info["resource"] as? [String: Any], let kind = resource["kind"] as? String {
            tap.kind = tap.kind ?? kind
            if kind == "session", let id = resource["id"] as? String, !id.isEmpty {
                tap.sessionID = tap.sessionID ?? id
            }
        }
        return tap
    }

    static func userInfo(for notice: Notice) -> [String: String] {
        var info: [String: String] = [noticeKey: notice.id]
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
    static let identifier = "com.twuijri.corehub.notices"

    /// Asks iOS to wake the app in about 15 minutes; iOS decides when, or whether.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date().addingTimeInterval(15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}
