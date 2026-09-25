@testable import CoreHub
import CoreHubClient
import Foundation
import XCTest

/// A hub that records what the registrar asks of it.
private final class FakePushBackend: PushBackend {
    var providersList: [PushProvider] = [.webpush, .apns]
    var registerPushStatuses: [Int] = []
    var devices: [String] = []
    var paired: String? = "dev-paired"
    private(set) var calls: [String] = []
    private(set) var registered: [(deviceID: String, token: String, locale: HubLocale)] = []

    private func refuse(_ status: Int) -> HubFailure {
        HubFailure(kind: .http, status: status, code: status == 409 ? "conflict" : "not_found", message: nil,
                   operationID: nil, requestID: nil, detail: "")
    }

    func providers() async throws -> [PushProvider] {
        calls.append("config")
        return providersList
    }

    func register(_ device: DeviceRegistration) async throws -> String {
        calls.append("register \(device.deviceKey)")
        let id = "dev-\(devices.count)"
        devices.append(id)
        return id
    }

    func thisDevice() async throws -> String? {
        calls.append("list")
        return paired
    }

    func registerPush(deviceID: String, token: String, locale: HubLocale) async throws {
        calls.append("push \(deviceID)")
        if !registerPushStatuses.isEmpty {
            let status = registerPushStatuses.removeFirst()
            if status != 200 { throw refuse(status) }
        }
        registered.append((deviceID, token, locale))
    }

    func unregisterPush(deviceID: String) async throws {
        calls.append("unpush \(deviceID)")
    }
}

final class PushTests: XCTestCase {
    private let phone = DeviceRegistration(deviceKey: "key-1", name: "iPhone", platform: .ios, kind: .phone)

    func testAPasswordSignInRegistersThisPhoneThenItsToken() async {
        let hub = FakePushBackend()
        let registrar = PushRegistrar(backend: hub)
        let outcome = await registrar.register(token: "ab12", locale: .ar, kind: .password, knownDeviceID: nil, device: phone)
        XCTAssertEqual(outcome, .registered(deviceID: "dev-0"))
        XCTAssertEqual(hub.calls, ["config", "register key-1", "push dev-0"])
        XCTAssertEqual(hub.registered.first?.token, "ab12")
        XCTAssertEqual(hub.registered.first?.locale, .ar)

        // The id is kept (PushCenter stores it in the credentials): a new token goes to the same device.
        let again = await registrar.register(token: "cd34", locale: .en, kind: .password, knownDeviceID: "dev-0", device: phone)
        XCTAssertEqual(again, .registered(deviceID: "dev-0"))
        XCTAssertEqual(hub.calls.suffix(2), ["config", "push dev-0"])
    }

    func testAPairedPhoneUsesTheDeviceItsPairingMade() async {
        let hub = FakePushBackend()
        let registrar = PushRegistrar(backend: hub)
        let known = await registrar.register(token: "ab12", locale: .ar, kind: .device, knownDeviceID: "dev-claim", device: phone)
        XCTAssertEqual(known, .registered(deviceID: "dev-claim"))
        XCTAssertEqual(hub.calls, ["config", "push dev-claim"])

        let found = await registrar.register(token: "ab12", locale: .ar, kind: .device, knownDeviceID: nil, device: phone)
        XCTAssertEqual(found, .registered(deviceID: "dev-paired"))
        XCTAssertFalse(hub.calls.contains { $0.hasPrefix("register") }, "a paired phone never registers a second device")
    }

    func testAHubWithoutAnAPNsSenderLeavesTheBackgroundLook() async {
        let hub = FakePushBackend()
        hub.providersList = [.webpush, .fcm]
        let registrar = PushRegistrar(backend: hub)
        let none = await registrar.register(token: "ab12", locale: .ar, kind: .password, knownDeviceID: "dev-0", device: phone)
        XCTAssertEqual(none, .noSender)
        XCTAssertEqual(hub.calls, ["config"])

        hub.providersList = [.apns]
        hub.registerPushStatuses = [409]
        let refused = await registrar.register(token: "ab12", locale: .ar, kind: .password, knownDeviceID: "dev-0", device: phone)
        XCTAssertEqual(refused, .noSender)
    }

    func testADeviceRemovedOnTheWebIsRegisteredAgainOnce() async {
        let hub = FakePushBackend()
        hub.registerPushStatuses = [404, 404]
        let registrar = PushRegistrar(backend: hub)
        let outcome = await registrar.register(token: "ab12", locale: .ar, kind: .password, knownDeviceID: "gone", device: phone)
        XCTAssertEqual(outcome, .failed(status: 404))
        XCTAssertEqual(hub.calls, ["config", "push gone", "register key-1", "push dev-0"])
    }

    func testSigningOutRemovesTheRegistration() async {
        let hub = FakePushBackend()
        let registrar = PushRegistrar(backend: hub)
        await registrar.unregister(deviceID: nil)
        XCTAssertEqual(hub.calls, [])
        await registrar.unregister(deviceID: "dev-0")
        XCTAssertEqual(hub.calls, ["unpush dev-0"])
    }

    func testTheTokenIsSentAsLowercaseHex() {
        XCTAssertEqual(PushRegistrar.hex(Data([0x00, 0xAB, 0x10, 0xFF])), "00ab10ff")
    }

    func testATappedPushOpensWhatItsNoticeIsAbout() {
        // The hub's payload beside `aps` (contract, devices-push section).
        let session: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Done"]],
            "type": "notice", "notice_id": "n1", "kind": "run_completed", "profile": "work",
            "resource": ["kind": "session", "id": "s1"],
        ]
        let tap = NoticeRouting.tap(from: session)
        XCTAssertEqual(tap, NoticeRouting.Tap(kind: "session", sessionID: "s1", profile: "work", noticeID: "n1"))
        XCTAssertEqual(
            NoticeRouting.route(kind: tap.kind, sessionID: tap.sessionID, profile: tap.profile, selector: "default"),
            .chat(sessionID: "s1", profile: "work")
        )

        let task = NoticeRouting.tap(from: ["type": "notice", "notice_id": "n2", "profile": NSNull(),
                                           "resource": ["kind": "task", "id": "t1"]])
        XCTAssertNil(task.sessionID)
        XCTAssertEqual(NoticeRouting.route(kind: task.kind, sessionID: task.sessionID, profile: task.profile, selector: "x"), .destination(.tasks))

        let bare = NoticeRouting.tap(from: ["type": "notice", "notice_id": "n3", "resource": NSNull()])
        XCTAssertNil(NoticeRouting.route(kind: bare.kind, sessionID: bare.sessionID, profile: bare.profile, selector: "x"))

        // A local notice's flat keys read the same way.
        let notice = Notice(
            id: "n4", userId: "u1", profile: "work", kind: .runCompleted, title: "Hermes finished",
            body: nil, resource: ResourceRef(kind: .session, id: "s2"), createdAt: Fixture.date
        )
        XCTAssertEqual(
            NoticeRouting.tap(from: NoticeRouting.userInfo(for: notice)),
            NoticeRouting.Tap(kind: "session", sessionID: "s2", profile: "work", noticeID: "n4")
        )
    }

    func testThisDeviceNamesEachPushState() {
        let keys = [PushState.active, .idle, .notAllowed, .noSender, .failed].map(ThisDeviceExtras.pushNote)
        XCTAssertEqual(Set(keys).count, 5)
        for language in [AppLanguage.ar, .en] {
            let l10n = L10n(language)
            for key in keys { XCTAssertTrue(l10n.has(key), "\(key) in \(language)") }
        }
    }
}
