// An agent asks where this phone is (contract decision §103): the request arrives on `/rt/devices`
// (`request.created`, sent to this device only) or is caught up with `listRequests?status=pending`
// when the app comes back; the person is asked once — «Allow every time», «Only this time»,
// «Don't allow» — and iOS's own location permission follows. «Every time» and «never» are kept on
// the phone and changed under This device; the hub only ever gets one answer per request.
import CoreHubClient
import CoreLocation
import Foundation
import Observation
import SwiftUI

enum LocationChoice: String, CaseIterable, Identifiable {
    case ask, always, never
    var id: String { rawValue }
}

/// The rules of answering, apart from iOS so they are unit-tested.
enum Locating {
    enum Next: Equatable { case ask, answer, deny, ignore }

    static func next(_ request: DeviceRequest, choice: LocationChoice, now: Date = Date()) -> Next {
        guard request.capability == .location, request.status == .pending, request.expiresAt > now else { return .ignore }
        switch choice {
        case .never: return .deny
        case .always: return .answer
        case .ask: return .ask
        }
    }

    /// The one shape a location has (§14).
    static func result(latitude: Double, longitude: Double, accuracy: Double, at date: Date) -> [String: JSONValue] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return [
            "latitude": .double(latitude),
            "longitude": .double(longitude),
            "accuracy_m": .double(max(0, accuracy)),
            "captured_at": .string(formatter.string(from: date)),
        ]
    }

    static func fulfilled(_ result: [String: JSONValue]) -> DeviceRequestResponse { DeviceRequestResponse(status: .fulfilled, result: result) }

    static func denied() -> DeviceRequestResponse {
        DeviceRequestResponse(status: .denied, error: DeviceRequestError(code: .permissionDenied, message: "the person said no"))
    }

    static func failed(_ message: String) -> DeviceRequestResponse {
        DeviceRequestResponse(status: .failed, error: DeviceRequestError(code: .unavailable, message: message))
    }

    /// What this phone tells the hub: its location, off once the person said never.
    static func capability(_ choice: LocationChoice) -> DeviceCapability {
        DeviceCapability(kind: .location, enabled: choice != .never)
    }

    static func request(from envelope: Envelope) -> DeviceRequest? {
        guard envelope.event == "request.created", envelope.namespace == "/rt/devices",
              let object = try? JSONSerialization.jsonObject(with: envelope.payload) as? [String: Any],
              let raw = object["request"], let data = try? JSONSerialization.data(withJSONObject: raw)
        else { return nil }
        return try? HubJSON.decoder.decode(DeviceRequest.self, from: data)
    }

    static let choiceKey = Product.storagePrefix + "location.choice"

    static func storedChoice(_ defaults: UserDefaults = .standard) -> LocationChoice {
        defaults.string(forKey: choiceKey).flatMap(LocationChoice.init(rawValue:)) ?? .ask
    }
}

/// One reading of where the phone is, asking iOS for the permission when it has not yet.
final class PhoneLocator: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var waiting: CheckedContinuation<CLLocation?, Never>?
    private var authorizing: CheckedContinuation<Void, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    @MainActor
    func current() async -> CLLocation? {
        if manager.authorizationStatus == .notDetermined {
            await withCheckedContinuation { continuation in
                authorizing = continuation
                manager.requestWhenInUseAuthorization()
            }
        }
        guard manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways else { return nil }
        return await withCheckedContinuation { continuation in
            waiting = continuation
            manager.requestLocation()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager.authorizationStatus != .notDetermined else { return }
        authorizing?.resume()
        authorizing = nil
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        waiting?.resume(returning: locations.last)
        waiting = nil
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        waiting?.resume(returning: nil)
        waiting = nil
    }
}

@MainActor
@Observable
final class LocationRequests {
    static let shared = LocationRequests()

    private(set) var waiting: [DeviceRequest] = []
    private(set) var choice: LocationChoice = Locating.storedChoice()
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var namespace: RealtimeNamespace?
    @ObservationIgnored private var listener: UUID?
    @ObservationIgnored private let locator = PhoneLocator()

    func start(app: AppModel) {
        self.app = app
        if namespace == nil {
            // This device's own requests reach this socket only (`device:<id>`).
            let devices = app.realtime.namespace("/rt/devices") { [weak app] in await app?.handshake(all: true) ?? [:] }
            namespace = devices
            listener = devices.onEvent { [weak self] _, argument in
                guard let envelope = Envelope.parse(argument), let request = Locating.request(from: envelope) else { return }
                Task { await self?.heard(request) }
            }
        }
        Task { await catchUp() }
    }

    func set(_ next: LocationChoice) {
        choice = next
        UserDefaults.standard.set(next.rawValue, forKey: Locating.choiceKey)
        Task { await app?.reportLocationChoice() }
    }

    func heard(_ request: DeviceRequest) async {
        switch Locating.next(request, choice: choice) {
        case .ask:
            if !waiting.contains(where: { $0.id == request.id }) { waiting.append(request) }
        case .answer:
            await answer(request)
        case .deny:
            await respond(request, Locating.denied())
        case .ignore:
            break
        }
    }

    /// Requests made while the app was closed.
    func catchUp() async {
        guard let app, let device = await app.api.keeper.credentials?.deviceID else { return }
        let profile = app.currentProfile
        let pending = try? await app.api.call {
            try await DevicesAPI.devicesListRequests(xHubProfile: profile, deviceId: device, status: .pending, limit: 20, apiConfiguration: $0)
        }.items
        for request in pending ?? [] { await heard(request) }
    }

    func decide(_ request: DeviceRequest, allow: Bool, remember: Bool) async {
        waiting.removeAll { $0.id == request.id }
        if remember { set(allow ? .always : .never) }
        if allow { await answer(request) } else { await respond(request, Locating.denied()) }
    }

    private func answer(_ request: DeviceRequest) async {
        guard let place = await locator.current() else {
            await respond(request, Locating.failed("the phone could not read its location"))
            return
        }
        let result = Locating.result(latitude: place.coordinate.latitude, longitude: place.coordinate.longitude, accuracy: place.horizontalAccuracy, at: place.timestamp)
        await respond(request, Locating.fulfilled(result))
    }

    private func respond(_ request: DeviceRequest, _ response: DeviceRequestResponse) async {
        guard let app else { return }
        let profile = request.profile, id = request.id
        _ = try? await app.api.call {
            try await DevicesAPI.devicesRespondRequest(xHubProfile: profile, requestId: id, deviceRequestResponse: response, apiConfiguration: $0)
        }
    }
}

extension AppModel {
    /// Tells the hub whether this phone answers location requests (after the person's choice).
    func reportLocationChoice() async {
        guard let device = await api.keeper.credentials?.deviceID else { return }
        let patch = DevicePatch(capabilities: [Locating.capability(LocationRequests.shared.choice)])
        _ = try? await api.call { try await DevicesAPI.devicesUpdate(deviceId: device, devicePatch: patch, apiConfiguration: $0) }
    }
}

/// The consent sheet: who asks and why, and the three answers.
struct LocationConsentSheet: View {
    let request: DeviceRequest
    @Environment(\.l10n) private var l10n
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            HStack(spacing: Space.s2) {
                LucideIcon(.mapPin, size: 22).foregroundStyle(Tone.accent)
                Text(l10n("locate.title")).font(.system(size: FontSize.sizeLg, weight: .semibold))
            }
            Text(l10n("locate.body")).font(.system(size: FontSize.sizeSm)).foregroundStyle(Tone.textMuted)
            if let why = request.purpose, !why.isEmpty, why != "devices.locate" {
                Text(l10n("locate.why", ["why": why])).font(.system(size: FontSize.sizeSm)).contentDirection(of: why)
            }
            Button {
                decide(allow: true, remember: true)
            } label: {
                LucideLabel(l10n("locate.always"), icon: .mapPin, size: 16).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).tint(Tone.accent)
            .accessibilityIdentifier("locate.always")
            Button { decide(allow: true, remember: false) } label: { Text(l10n("locate.once")).frame(maxWidth: .infinity) }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("locate.once")
            Button(role: .destructive) { decide(allow: false, remember: true) } label: { Text(l10n("locate.never")).frame(maxWidth: .infinity) }
                .accessibilityIdentifier("locate.never")
        }
        .disabled(busy)
        .padding(Space.s4)
        .presentationDetents([.medium])
        .interactiveDismissDisabled(busy)
    }

    private func decide(allow: Bool, remember: Bool) {
        busy = true
        let request = request
        Task { await LocationRequests.shared.decide(request, allow: allow, remember: remember) }
    }
}

/// This device's row: ask, always, or never.
struct LocationChoiceSection: View {
    @Environment(\.l10n) private var l10n

    var body: some View {
        let requests = LocationRequests.shared
        Section {
            Picker(l10n("locate.heading"), selection: Binding(get: { requests.choice }, set: { requests.set($0) })) {
                Text(l10n("locate.ask")).tag(LocationChoice.ask)
                Text(l10n("locate.choice_always")).tag(LocationChoice.always)
                Text(l10n("locate.choice_never")).tag(LocationChoice.never)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("locate.choice")
        } header: {
            Text(l10n("locate.heading"))
        } footer: {
            Text(l10n("locate.hint"))
        }
    }
}
