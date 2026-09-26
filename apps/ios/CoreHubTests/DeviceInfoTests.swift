@testable import CoreHub
import CoreHubClient
import Foundation
import UserNotifications
import XCTest

/// How this phone describes itself to the hub (docs/changes/2026-09-26-twuijri-device-cards.md).
final class DeviceInfoTests: XCTestCase {
    func testTheModelIsItsMarketingNameAndAnUnknownOneIsSentAsItIs() {
        XCTAssertEqual(DeviceInfo.marketingName(machine: "iPhone17,1"), "iPhone 16 Pro")
        XCTAssertEqual(DeviceInfo.marketingName(machine: "iPhone15,4"), "iPhone 15")
        XCTAssertEqual(DeviceInfo.marketingName(machine: "iPad16,5"), "iPad Pro 13-inch (M4)")
        XCTAssertEqual(DeviceInfo.marketingName(machine: "iPhone99,9"), "iPhone99,9")
        XCTAssertNil(DeviceInfo.marketingName(machine: "arm64"))
        XCTAssertNil(DeviceInfo.marketingName(machine: nil))
        XCTAssertNil(DeviceInfo.marketingName(machine: " "))
    }

    func testAGenericNameStaysAndTheModelTellsPhonesApart() {
        let described = DeviceInfo.describe(deviceName: "iPhone", idiomModel: "iPhone", machine: "iPhone17,1",
                                            systemVersion: "18.6", appVersion: "0.1.0")
        XCTAssertEqual(described, DeviceDescription(name: "iPhone", model: "iPhone 16 Pro", osVersion: "18.6",
                                                    appVersion: "0.1.0"))
        // A name the phone does report (with the entitlement, or an older iOS) is kept.
        XCTAssertEqual(
            DeviceInfo.describe(deviceName: "Abdulaziz's iPhone", idiomModel: "iPhone", machine: "iPhone16,1",
                                systemVersion: "26.0", appVersion: nil).name,
            "Abdulaziz's iPhone"
        )
    }

    func testMissingPartsAreLeftOutAndLongOnesFit() {
        let described = DeviceInfo.describe(deviceName: "  ", idiomModel: "iPad", machine: "arm64",
                                            systemVersion: " ", appVersion: " ")
        XCTAssertEqual(described, DeviceDescription(name: "iPad", model: "iPad", osVersion: nil, appVersion: nil))
        let long = DeviceInfo.describe(deviceName: String(repeating: "x", count: 200), idiomModel: "iPhone",
                                       machine: nil, systemVersion: "18.6", appVersion: "1")
        XCTAssertEqual(long.name.count, 80)
    }

    func testWhatStopsPushIsThePermission() {
        XCTAssertEqual(DeviceInfo.pushBlocker(.notDetermined), .permissionPending)
        XCTAssertEqual(DeviceInfo.pushBlocker(.denied), .permissionDenied)
        XCTAssertEqual(DeviceInfo.pushBlocker(.authorized), ._none)
        XCTAssertEqual(DeviceInfo.pushBlocker(.provisional), ._none)
    }
}

/// What the app tells the hub at each launch, against a scripted hub.
private final class ReportingBackend: PushBackend {
    var paired: String? = "dev-paired"
    var updateStatuses: [Int] = []
    private(set) var calls: [String] = []
    private(set) var patches: [DevicePatch] = []

    func providers() async throws -> [PushProvider] { [.apns] }

    func register(_ device: DeviceRegistration) async throws -> String {
        calls.append("register \(device.osVersion ?? "-")")
        return "dev-new"
    }

    func thisDevice() async throws -> String? {
        calls.append("list")
        return paired
    }

    func registerPush(deviceID: String, token: String, locale: HubLocale, proof: PushRelayProof?) async throws {}
    func unregisterPush(deviceID: String) async throws {}

    func update(deviceID: String, patch: DevicePatch) async throws {
        calls.append("update \(deviceID)")
        if !updateStatuses.isEmpty, updateStatuses.removeFirst() != 200 {
            throw HubFailure(kind: .http, status: 404, code: "not_found", message: nil, operationID: nil,
                             requestID: nil, detail: "")
        }
        patches.append(patch)
    }
}

final class DeviceReportTests: XCTestCase {
    private let patch = DevicePatch(brand: "Apple", model: "iPhone 16 Pro", osVersion: "26.0", appVersion: "0.2.0",
                                    pushBlocker: .permissionPending)
    private let phone = DeviceRegistration(deviceKey: "key-1", name: "iPhone", platform: .ios, kind: .phone,
                                           osVersion: "26.0")

    func testAPairedPhoneReportsWhatItIsButNeverItsName() async {
        let hub = ReportingBackend()
        let id = await PushRegistrar(backend: hub).report(patch, kind: .device, knownDeviceID: "dev-claim", device: phone)
        XCTAssertEqual(id, "dev-claim")
        XCTAssertEqual(hub.calls, ["update dev-claim"])
        XCTAssertEqual(hub.patches.first?.osVersion, "26.0")
        XCTAssertEqual(hub.patches.first?.pushBlocker, .permissionPending)
        XCTAssertNil(hub.patches.first?.name)

        // Paired before the id was kept: it finds itself first.
        let found = await PushRegistrar(backend: hub).report(patch, kind: .device, knownDeviceID: nil, device: phone)
        XCTAssertEqual(found, "dev-paired")
        XCTAssertEqual(hub.calls.suffix(2), ["list", "update dev-paired"])
    }

    func testAPasswordSignInRegistersOnceAndARemovedRowAgain() async {
        let hub = ReportingBackend()
        let first = await PushRegistrar(backend: hub).report(patch, kind: .password, knownDeviceID: nil, device: phone)
        XCTAssertEqual(first, "dev-new")
        XCTAssertEqual(hub.calls, ["register 26.0"])

        hub.updateStatuses = [404]
        let again = await PushRegistrar(backend: hub).report(patch, kind: .password, knownDeviceID: "dev-gone", device: phone)
        XCTAssertEqual(again, "dev-new")
        XCTAssertEqual(hub.calls.suffix(2), ["update dev-gone", "register 26.0"])
    }
}
