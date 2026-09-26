@testable import CoreHub
import CoreHubClient
import XCTest

/// An agent asks where the phone is (§105): what the phone does with the request, and what it sends.
final class LocateTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    private func request(_ capability: CapabilityKind = .location, status: DeviceRequestStatus = .pending, expires: TimeInterval = 60) -> DeviceRequest {
        DeviceRequest(
            id: "r1", profile: "work", ownerId: "me", createdAt: now, updatedAt: now, deviceId: "d1", runId: "run", jobId: "j",
            capability: capability, purpose: "أقرب صيدلية", params: [:], status: status, expiresAt: now.addingTimeInterval(expires)
        )
    }

    func testTheFirstTimeThePersonIsAskedAndTheirAlwaysOrNeverIsKept() {
        XCTAssertEqual(Locating.next(request(), choice: .ask, now: now), .ask)
        XCTAssertEqual(Locating.next(request(), choice: .always, now: now), .answer)
        XCTAssertEqual(Locating.next(request(), choice: .never, now: now), .deny)
        XCTAssertEqual(Locating.next(request(.camera), choice: .always, now: now), .ignore)
        XCTAssertEqual(Locating.next(request(status: .expired), choice: .always, now: now), .ignore)
        XCTAssertEqual(Locating.next(request(expires: -1), choice: .ask, now: now), .ignore)
        XCTAssertTrue(Locating.capability(.ask).enabled)
        XCTAssertFalse(Locating.capability(.never).enabled)
    }

    func testALocationIsTheOneShapeTheHubTakes() {
        let result = Locating.result(latitude: 24.7136, longitude: 46.6753, accuracy: -3, at: now)
        XCTAssertEqual(result["latitude"], .double(24.7136))
        XCTAssertEqual(result["accuracy_m"], .double(0))
        XCTAssertEqual(result["captured_at"], .string("2026-09-21T14:13:20Z"))
        XCTAssertEqual(Locating.denied().error?.code, .permissionDenied)
        XCTAssertEqual(Locating.failed("x").status, .failed)
    }

    func testOnlyARequestForThisPhoneOnTheDevicesSocketIsHeard() throws {
        let body = """
        {"event":"request.created","namespace":"/rt/devices","profile":"work","seq":3,"ts":"2026-09-21T14:13:20Z",
         "payload":{"request":{"id":"r1","profile":"work","owner_id":"me","created_at":"2026-09-21T14:13:20Z","updated_at":"2026-09-21T14:13:20Z",
          "device_id":"d1","session_id":null,"run_id":null,"job_id":"j","capability":"location","purpose":null,"params":{},
          "status":"pending","expires_at":"2026-09-21T14:14:50Z","result":null,"error":null}}}
        """
        let envelope = try XCTUnwrap(Envelope.parse(Data(body.utf8)))
        XCTAssertEqual(Locating.request(from: envelope)?.id, "r1")
        let other = try XCTUnwrap(Envelope.parse(Data(body.replacingOccurrences(of: "request.created", with: "request.completed").utf8)))
        XCTAssertNil(Locating.request(from: other))
    }
}
