// What this phone tells the hub about itself, so the web's device card can tell two phones
// apart (docs/changes/2026-09-26-twuijri-device-cards.md): its model by marketing name, the
// iOS version and the app's version, and what stops push on it. Since iOS 16 `UIDevice.name`
// is only "iPhone" without a special entitlement, so the model is what tells phones apart —
// and the person can give the phone its own name on the hub, which the app never overwrites.
import CoreHubClient
import Foundation
import UIKit
import UserNotifications

struct DeviceDescription: Equatable {
    var name: String
    var model: String?
    var osVersion: String?
    var appVersion: String?
}

enum DeviceInfo {
    /// Apple's model identifiers (`utsname.machine`) by the name people know. An identifier not
    /// in the table (a phone newer than this build) is sent as it is: still tells phones apart.
    static let marketingNames: [String: String] = [
        "iPhone11,2": "iPhone XS", "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max",
        "iPhone11,8": "iPhone XR",
        "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max",
        "iPhone12,8": "iPhone SE (2nd generation)",
        "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro",
        "iPhone13,4": "iPhone 12 Pro Max",
        "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro",
        "iPhone14,3": "iPhone 13 Pro Max", "iPhone14,6": "iPhone SE (3rd generation)",
        "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
        "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max",
        "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
        "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
        "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,1": "iPhone 16 Pro",
        "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,5": "iPhone 16e",
        "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17",
        "iPhone18,4": "iPhone Air",
        "iPad13,18": "iPad (10th generation)", "iPad13,19": "iPad (10th generation)",
        "iPad14,1": "iPad mini (6th generation)", "iPad14,2": "iPad mini (6th generation)",
        "iPad13,16": "iPad Air (5th generation)", "iPad13,17": "iPad Air (5th generation)",
        "iPad14,8": "iPad Air 11-inch (M2)", "iPad14,9": "iPad Air 11-inch (M2)",
        "iPad14,10": "iPad Air 13-inch (M2)", "iPad14,11": "iPad Air 13-inch (M2)",
        "iPad16,3": "iPad Pro 11-inch (M4)", "iPad16,4": "iPad Pro 11-inch (M4)",
        "iPad16,5": "iPad Pro 13-inch (M4)", "iPad16,6": "iPad Pro 13-inch (M4)",
    ]

    /// The model's name for an identifier; the identifier itself when unknown; nil for none
    /// (the simulator on a Mac says `arm64` until its own model is looked up).
    static func marketingName(machine: String?) -> String? {
        guard let machine = machine?.trimmingCharacters(in: .whitespaces), !machine.isEmpty else { return nil }
        if let known = marketingNames[machine] { return known }
        return machine.hasPrefix("iPhone") || machine.hasPrefix("iPad") ? machine : nil
    }

    /// The pure part, tested (DeviceInfoTests).
    static func describe(deviceName: String, idiomModel: String, machine: String?, systemVersion: String,
                         appVersion: String?) -> DeviceDescription {
        let model = marketingName(machine: machine) ?? idiomModel
        let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        let version = systemVersion.trimmingCharacters(in: .whitespaces)
        let app = appVersion?.trimmingCharacters(in: .whitespaces)
        return DeviceDescription(
            name: String((name.isEmpty ? model : name).prefix(80)),
            model: model.isEmpty ? nil : String(model.prefix(120)),
            osVersion: version.isEmpty ? nil : String(version.prefix(64)),
            appVersion: (app?.isEmpty ?? true) ? nil : app.map { String($0.prefix(32)) }
        )
    }

    /// `utsname.machine`, or the model the simulator stands for.
    static func machineID() -> String? {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        var system = utsname()
        uname(&system)
        let bytes = Mirror(reflecting: system.machine).children.compactMap { $0.value as? Int8 }
        let text = String(decoding: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return text.isEmpty ? nil : text
    }

    @MainActor
    static func current(appVersion: String) -> DeviceDescription {
        let device = UIDevice.current
        return describe(deviceName: device.name, idiomModel: device.model, machine: machineID(),
                        systemVersion: device.systemVersion, appVersion: appVersion)
    }

    /// What stops push here, as the hub's `PushBlocker`: the notification permission. (Every
    /// build of the app can receive APNs; one without the entitlement fails to register, and
    /// This device says so.)
    static func pushBlocker(_ status: UNAuthorizationStatus) -> PushBlocker {
        switch status {
        case .notDetermined: return .permissionPending
        case .denied: return .permissionDenied
        default: return ._none
        }
    }
}
