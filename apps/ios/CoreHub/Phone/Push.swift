// Push through APNs (docs/changes/2026-09-25-twuijri-devices-push.md, "what the apps call"): after
// sign-in the app asks iOS for notifications, registers for remote notifications, and sends the
// device token to the hub (`devices.registerPush`, provider `apns`). While that holds, the hub's
// pushes carry the notices and the background look (`NoticeRefresh`) is not scheduled; anything
// else — no permission, no APNs sender on the hub, an error — keeps the background look.
import CoreHubClient
import Foundation
import Observation
import UIKit
import UserNotifications

/// What This device says about push.
enum PushState: Equatable {
    /// Not signed in, or not tried yet.
    case idle
    /// The person has not allowed notifications: nothing can be shown, push or not.
    case notAllowed
    /// The hub has no APNs sender (Device connections → Push senders).
    case noSender
    /// The hub has this phone's token.
    case active
    /// iOS or the hub refused; the background look goes on and the next launch tries again.
    case failed
}

/// What the registrar needs from the hub, so its rules are tested without a network.
protocol PushBackend {
    func providers() async throws -> [PushProvider]
    /// `devices.register`: this install as a device of a password sign-in; its id.
    func register(_ device: DeviceRegistration) async throws -> String
    /// The id of the device a pairing made (`this_device` in `devices.list`).
    func thisDevice() async throws -> String?
    func registerPush(deviceID: String, token: String, locale: HubLocale) async throws
    func unregisterPush(deviceID: String) async throws
}

/// The rules of registering this phone's APNs token. Pure over `PushBackend`; tested.
struct PushRegistrar {
    enum Outcome: Equatable {
        case registered(deviceID: String)
        case noSender
        case failed(status: Int)
    }

    let backend: PushBackend

    /// The device the token belongs to: the one the pairing made (paired by QR), or this install
    /// registered as a device (`devices.register` with its stable `device_key`; the hub answers
    /// with the same row every time). A password session whose row was removed on the web
    /// registers again, once.
    func register(token: String, locale: HubLocale, kind: Credentials.Kind, knownDeviceID: String?,
                  device: DeviceRegistration) async -> Outcome {
        do {
            guard try await backend.providers().contains(.apns) else { return .noSender }
        } catch {
            return .failed(status: HubFailure(error).status)
        }
        var deviceID = knownDeviceID
        var retried = false
        while true {
            let id: String
            if let deviceID {
                id = deviceID
            } else {
                do {
                    switch kind {
                    case .device:
                        guard let found = try await backend.thisDevice() else { return .failed(status: 404) }
                        id = found
                    case .password:
                        id = try await backend.register(device)
                    }
                } catch {
                    return .failed(status: HubFailure(error).status)
                }
            }
            do {
                try await backend.registerPush(deviceID: id, token: token, locale: locale)
                return .registered(deviceID: id)
            } catch {
                let failure = HubFailure(error)
                if failure.status == 409 { return .noSender }
                if failure.status == 404, kind == .password, !retried {
                    retried = true
                    deviceID = nil
                    continue
                }
                return .failed(status: failure.status)
            }
        }
    }

    /// Stops pushes to this phone; best effort, signing out goes on whatever the hub answers.
    func unregister(deviceID: String?) async {
        guard let deviceID else { return }
        try? await backend.unregisterPush(deviceID: deviceID)
    }

    /// The APNs device token as the hub takes it: lowercase hex.
    static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }
}

/// The hub behind `PushBackend`, through the generated client only.
struct HubPushBackend: PushBackend {
    let api: HubAPI

    func providers() async throws -> [PushProvider] {
        try await api.call { try await DevicesAPI.devicesGetPushConfig(apiConfiguration: $0) }.providers
    }

    func register(_ device: DeviceRegistration) async throws -> String {
        try await api.call { try await DevicesAPI.devicesRegister(deviceRegistration: device, apiConfiguration: $0) }.id
    }

    func thisDevice() async throws -> String? {
        var cursor: String?
        for _ in 0..<20 {
            let after = cursor
            let page = try await api.call {
                try await DevicesAPI.devicesList(cursor: after, limit: 100, apiConfiguration: $0)
            }
            if let mine = page.items.first(where: { $0.thisDevice }) { return mine.id }
            guard let next = page.nextCursor else { return nil }
            cursor = next
        }
        return nil
    }

    func registerPush(deviceID: String, token: String, locale: HubLocale) async throws {
        let registration = PushRegistration(provider: .apns, token: token, locale: locale)
        _ = try await api.call {
            try await DevicesAPI.devicesRegisterPush(deviceId: deviceID, pushRegistration: registration, apiConfiguration: $0)
        }
    }

    func unregisterPush(deviceID: String) async throws {
        try await api.call { try await DevicesAPI.devicesUnregisterPush(deviceId: deviceID, apiConfiguration: $0) }
    }
}

/// APNs on this phone: asks, registers, hands the token to the hub, and forgets it at sign-out.
@MainActor
@Observable
final class PushCenter {
    static let shared = PushCenter()

    private(set) var state: PushState = .idle
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var token: String?

    var isActive: Bool { state == .active }

    /// After each sign-in and at each launch while signed in. Asking for permission happens once
    /// right after sign-in (AppModel.finishSignIn); here the answer decides whether to register.
    func start(app: AppModel) async {
        self.app = app
        switch await LocalNotices.shared.status() {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
        default:
            state = .notAllowed
        }
    }

    /// iOS gave a device token (the app delegate); it may change, so each one is sent.
    func received(deviceToken: Data) {
        let token = PushRegistrar.hex(deviceToken)
        self.token = token
        Task { await register(token) }
    }

    func failed() {
        state = .failed
    }

    private func register(_ token: String) async {
        guard let app, let credentials = await app.keeper.credentials else { return }
        let locale = HubLocale(rawValue: app.language.rawValue) ?? .ar
        let registrar = PushRegistrar(backend: HubPushBackend(api: app.api))
        let outcome = await registrar.register(
            token: token, locale: locale, kind: credentials.kind, knownDeviceID: credentials.deviceID,
            device: app.thisDevice()
        )
        guard app.phase == .signedIn else { return }
        switch outcome {
        case .registered(let id):
            if credentials.deviceID != id {
                await app.keeper.update { if $0.userID == credentials.userID { $0.deviceID = id } }
            }
            state = .active
        case .noSender:
            state = .noSender
        case .failed:
            state = .failed
        }
    }

    /// Before signing out, while the token still works: the hub stops pushing to this phone.
    func signOut(deviceID: String?) async {
        guard let app else {
            state = .idle
            return
        }
        await PushRegistrar(backend: HubPushBackend(api: app.api)).unregister(deviceID: deviceID)
        state = .idle
    }

    /// Signed out by the hub: nothing to tell it.
    func reset() {
        state = .idle
    }
}

/// Receives the APNs token (SwiftUI has no other way to it) and makes the notification centre's
/// delegate the app's before launch finishes, so a tap that launched the app is not lost.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = LocalNotices.shared
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushCenter.shared.received(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushCenter.shared.failed()
    }
}
