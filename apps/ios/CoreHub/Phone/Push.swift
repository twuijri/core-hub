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
    /// iOS has not asked the person yet (`.notDetermined`): the app asks, once a launch.
    case waiting
    /// The person turned notifications off: nothing can be shown, push or not. Only the
    /// iPhone's Settings can change it; the app never asks again.
    case notAllowed
    /// The hub has no APNs sender (Device connections → Push senders).
    case noSender
    /// The hub has this phone's token.
    case active
    /// iOS or the hub refused; the background look goes on and the next launch tries again.
    case failed
}

extension PushState {
    /// What the permission alone decides; nil when notifications are allowed and the phone
    /// goes on to register with the hub.
    static func before(registering status: UNAuthorizationStatus) -> PushState? {
        switch status {
        case .authorized, .provisional, .ephemeral: return nil
        case .notDetermined: return .waiting
        case .denied: return .notAllowed
        @unknown default: return .notAllowed
        }
    }

    /// Worth trying again when the app comes back to the front: not tried yet, the person may
    /// have changed Settings, or the hub may have been given an APNs sender since.
    var retriesOnForeground: Bool {
        switch self {
        case .idle, .waiting, .notAllowed, .noSender, .failed: return true
        case .active: return false
        }
    }
}

/// When to show iOS's notification prompt: only while iOS has not asked yet, only with the app
/// in front (iOS drops an alert asked for from the background), and at most once a launch — a
/// person who closes it without answering is asked again next launch, never nagged in a loop.
struct PermissionPrompt {
    private(set) var askedThisLaunch = false

    mutating func shouldAsk(status: UNAuthorizationStatus, appActive: Bool) -> Bool {
        guard status == .notDetermined, appActive, !askedThisLaunch else { return false }
        askedThisLaunch = true
        return true
    }
}

/// What the registrar needs from the hub, so its rules are tested without a network.
protocol PushBackend {
    func providers() async throws -> [PushProvider]
    /// `devices.register`: this install as a device of a password sign-in; its id.
    func register(_ device: DeviceRegistration) async throws -> String
    /// The id of the device a pairing made (`this_device` in `devices.list`).
    func thisDevice() async throws -> String?
    /// `devices.registerPush`, with the relay's device proof when this install could make one.
    func registerPush(deviceID: String, token: String, locale: HubLocale, proof: PushRelayProof?) async throws
    func unregisterPush(deviceID: String) async throws
    /// `devices.update`: what the phone says about itself at each launch.
    func update(deviceID: String, patch: DevicePatch) async throws
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
                  device: DeviceRegistration, proof: PushRelayProof? = nil) async -> Outcome {
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
                try await backend.registerPush(deviceID: id, token: token, locale: locale, proof: proof)
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

    /// At each launch: tells the hub what this phone is now. A password sign-in with no device
    /// row yet registers one (which says all of it); a row removed on the web is registered
    /// again, once. Returns the device's id, or nil when the hub could not be told.
    func report(_ patch: DevicePatch, kind: Credentials.Kind, knownDeviceID: String?,
                device: DeviceRegistration) async -> String? {
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
                        guard let found = try await backend.thisDevice() else { return nil }
                        id = found
                    case .password:
                        // Registering describes the phone in full: nothing more to send.
                        return try await backend.register(device)
                    }
                } catch {
                    return nil
                }
            }
            do {
                try await backend.update(deviceID: id, patch: patch)
                return id
            } catch {
                if HubFailure(error).status == 404, kind == .password, !retried {
                    retried = true
                    deviceID = nil
                    continue
                }
                return nil
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

    func registerPush(deviceID: String, token: String, locale: HubLocale, proof: PushRelayProof?) async throws {
        let registration = PushRegistration(provider: .apns, token: token, locale: locale, relayProof: proof)
        _ = try await api.call {
            try await DevicesAPI.devicesRegisterPush(deviceId: deviceID, pushRegistration: registration, apiConfiguration: $0)
        }
    }

    func unregisterPush(deviceID: String) async throws {
        try await api.call { try await DevicesAPI.devicesUnregisterPush(deviceId: deviceID, apiConfiguration: $0) }
    }

    func update(deviceID: String, patch: DevicePatch) async throws {
        _ = try await api.call {
            try await DevicesAPI.devicesUpdate(deviceId: deviceID, devicePatch: patch, apiConfiguration: $0)
        }
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
    @ObservationIgnored private var prompt = PermissionPrompt()
    @ObservationIgnored private var starting = false
    /// This install's proof for the push relay (DeviceProof.swift).
    @ObservationIgnored var proofs = DeviceProof(store: KeychainProofKeyStore())
    /// Drops this app's APNs registration (a seam: the tests count the calls).
    @ObservationIgnored var unregisterRemote: @MainActor () -> Void = {
        UIApplication.shared.unregisterForRemoteNotifications()
    }

    /// The APNs token this launch holds, if any.
    var heldToken: String? { token }

    var isActive: Bool { state == .active }

    /// After each sign-in, at each launch while signed in, and when the app comes to the front
    /// in a state worth retrying (`retriesOnForeground`). While iOS has not asked yet, the app
    /// asks here — in front, after a moment so a closing sheet or the QR scanner is gone — once
    /// a launch; with a yes, or a yes given earlier, the phone registers for push with the hub.
    func start(app: AppModel) async {
        self.app = app
        guard !starting else { return }
        starting = true
        defer { starting = false }
        var status = await LocalNotices.shared.status()
        let active = UIApplication.shared.applicationState == .active
        if prompt.shouldAsk(status: status, appActive: active) {
            try? await Task.sleep(nanoseconds: 700_000_000)
            _ = await LocalNotices.shared.requestPermission()
            status = await LocalNotices.shared.status()
        }
        // Whatever the answer, the hub's card for this phone hears it (and the versions) now.
        await report(blocker: DeviceInfo.pushBlocker(status))
        if let before = PushState.before(registering: status) {
            state = before
            return
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// The app came to the front: try again what may have changed meanwhile.
    func foreground(app: AppModel) async {
        guard state.retriesOnForeground else { return }
        await start(app: app)
    }

    /// Tells the hub what this phone is now (model, iOS and app versions, what stops push), so
    /// its card on the web is current; the device id it learns is kept with the sign-in.
    private func report(blocker: PushBlocker) async {
        guard let app, let credentials = await app.keeper.credentials else { return }
        let registrar = PushRegistrar(backend: HubPushBackend(api: app.api))
        let id = await registrar.report(
            app.thisDeviceReport(pushBlocker: blocker), kind: credentials.kind,
            knownDeviceID: credentials.deviceID, device: app.thisDevice(pushBlocker: blocker)
        )
        if let id, credentials.deviceID != id {
            await app.keeper.update { if $0.userID == credentials.userID { $0.deviceID = id } }
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
            device: app.thisDevice(pushBlocker: ._none),
            proof: proofs.proof(platform: "apns", token: token)
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

    /// Signed out: this phone's push is idle until the next sign-in.
    func reset() {
        state = .idle
    }

    /// Signed out by the hub (a 401 at launch or on a call): the ended sign-in cannot tell the
    /// hub anything, and the hub forgot this phone's token when that sign-in ended. What is left
    /// here goes too — the token this launch held, and the APNs registration itself, so APNs
    /// refuses the old token to any hub or relay still holding it (one older than that clean-up
    /// answers `Unregistered` and forgets it). The next sign-in registers again (`start`). The
    /// proof key stays: it is this install's, whichever hub it signs in to.
    func endedByHub() {
        token = nil
        state = .idle
        unregisterRemote()
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
