@testable import CoreHub
import XCTest

final class EngineIOTests: XCTestCase {
    func testEngineIOPackets() {
        XCTAssertEqual(EngineIOPacket.decode(#"0{"sid":"a"}"#), .open(#"{"sid":"a"}"#))
        XCTAssertEqual(EngineIOPacket.decode("2"), .ping(""))
        XCTAssertEqual(EngineIOPacket.pong("").encoded, "3")
        XCTAssertEqual(EngineIOPacket.decode("40/rt/sessions,"), .message("0/rt/sessions,"))
        XCTAssertNil(EngineIOPacket.decode(""))
        XCTAssertNil(EngineIOPacket.decode("x"))
    }

    func testHandshakeDecodes() throws {
        let data = #"{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#.data(using: .utf8)!
        let handshake = try JSONDecoder().decode(EngineIOHandshake.self, from: data)
        XCTAssertEqual(handshake.pingInterval, 25000)
    }

    func testConnectingANamespaceCarriesTheAuth() {
        let packet = SocketIOPacket(kind: .connect, namespace: "/rt/sessions", payload: #"{"token":"t"}"#)
        XCTAssertEqual(EngineIOPacket.message(packet.encoded).encoded, #"40/rt/sessions,{"token":"t"}"#)
    }

    func testEventsWithAndWithoutNamespaceAndAck() {
        let event = SocketIOPacket.decode(#"2/rt/sessions,["message.delta",{"seq":4}]"#)
        XCTAssertEqual(event?.kind, .event)
        XCTAssertEqual(event?.namespace, "/rt/sessions")
        XCTAssertNil(event?.id)
        XCTAssertEqual(event?.eventContent?.name, "message.delta")
        let argument = event?.eventContent?.argument.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Int] }
        XCTAssertEqual(argument?["seq"], 4)

        let root = SocketIOPacket.decode(#"2["hello"]"#)
        XCTAssertEqual(root?.namespace, "/")
        XCTAssertEqual(root?.eventContent?.name, "hello")
        XCTAssertNil(root?.eventContent?.argument)

        let ack = SocketIOPacket.decode(#"3/rt/sessions,12[{"ok":true,"replayed":2}]"#)
        XCTAssertEqual(ack?.kind, .ack)
        XCTAssertEqual(ack?.id, 12)
        XCTAssertEqual(SubscribeAck.parse(ack?.ackArgument).replayed, 2)
    }

    func testEmittingWithAnAckID() {
        let packet = SocketIOPacket.event("subscribe", data: ["session_id": "s1"], namespace: "/rt/sessions", id: 7)
        XCTAssertEqual(packet.encoded, #"2/rt/sessions,7["subscribe",{"session_id":"s1"}]"#)
        XCTAssertEqual(SocketIOPacket.decode(packet.encoded), packet)
    }

    func testARefusedHandshakeSaysItsCode() {
        let refused = SocketIOPacket.decode(#"4/rt/sessions,{"message":"token_expired","data":{"code":"token_expired"}}"#)
        XCTAssertEqual(refused?.kind, .connectError)
        XCTAssertEqual(refused?.connectErrorCode, "token_expired")
        let bare = SocketIOPacket.decode(#"4/rt/sessions,{"message":"unauthorized"}"#)
        XCTAssertEqual(bare?.connectErrorCode, "unauthorized")
    }

    func testNamespaceDisconnect() {
        let packet = SocketIOPacket.decode("1/rt/sessions,")
        XCTAssertEqual(packet?.kind, .disconnect)
        XCTAssertEqual(packet?.namespace, "/rt/sessions")
        XCTAssertNil(packet?.payload)
    }

    func testBackoffIsCappedAtThirtySeconds() {
        XCTAssertEqual(RealtimeClient.backoff(attempt: 0), 1)
        XCTAssertEqual(RealtimeClient.backoff(attempt: 3), 8)
        XCTAssertEqual(RealtimeClient.backoff(attempt: 9), 30)
    }

    func testEnvelopeParsing() {
        let data = #"{"event":"session.deleted","namespace":"/rt/sessions","profile":null,"ts":"2026-09-25T10:00:00Z","seq":8812,"payload":{"session_id":"s1"}}"#.data(using: .utf8)
        let envelope = Envelope.parse(data)
        XCTAssertEqual(envelope?.seq, 8812)
        XCTAssertNil(envelope?.profile)
        if case .sessionDeleted(let id)? = envelope.flatMap(SessionEvent.decode) {
            XCTAssertEqual(id, "s1")
        } else {
            XCTFail("session.deleted did not decode")
        }
        XCTAssertNil(Envelope.parse(#"{"event":"x"}"#.data(using: .utf8)))
    }
}

final class PairingTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    func testTheWebsQRCodeParses() {
        let text = #"{"type":"corehub.pairing","hub_url":"https://hub.example.com/","pairing_id":"01J8QK3ZR2W7M5N4P6T8V9X0PR","code":"7KQ2-M9XW","expires_at":"2026-09-21T11:16:00Z"}"#
        let result = PairingPayload.parse(text, now: HubDate.parse("2026-09-21T11:10:00Z")!)
        guard case .success(let payload) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(payload.hubURL.absoluteString, "https://hub.example.com")
        XCTAssertEqual(payload.code, "7KQ2-M9XW")
        XCTAssertEqual(payload.pairingID, "01J8QK3ZR2W7M5N4P6T8V9X0PR")
    }

    func testAnOlderHubsTypeIsStillRead() {
        let text = #"{"type":"majlis.pairing","hub_url":"http://192.168.1.5:8080","pairing_id":"p","code":"c"}"#
        guard case .success(let payload) = PairingPayload.parse(text, now: now) else { return XCTFail() }
        XCTAssertEqual(payload.hubURL.absoluteString, "http://192.168.1.5:8080")
        XCTAssertNil(payload.expiresAt)
    }

    func testOtherCodesAreRefused() {
        XCTAssertEqual(PairingPayload.parse("https://example.com", now: now), .failure(.notAPairingCode))
        XCTAssertEqual(PairingPayload.parse(#"{"type":"other","hub_url":"https://h","pairing_id":"p","code":"c"}"#, now: now), .failure(.notAPairingCode))
        XCTAssertEqual(PairingPayload.parse(#"{"type":"corehub.pairing","hub_url":"ftp://h","pairing_id":"p","code":"c"}"#, now: now), .failure(.notAPairingCode))
        XCTAssertEqual(PairingPayload.parse(#"{"type":"corehub.pairing","hub_url":"https://h","pairing_id":"p","code":"c","expires_at":"2020-01-01T00:00:00Z"}"#, now: now), .failure(.expired))
    }

    func testHubAddresses() {
        XCTAssertEqual(HubAddress.normalise("hub.example.com")?.absoluteString, "https://hub.example.com")
        XCTAssertEqual(HubAddress.normalise(" HTTP://10.0.0.2:8080/ ")?.absoluteString, "http://10.0.0.2:8080")
        XCTAssertEqual(HubAddress.normalise("https://example.com/hub/?x=1#y")?.absoluteString, "https://example.com/hub")
        XCTAssertNil(HubAddress.normalise(""))
        XCTAssertNil(HubAddress.normalise("not a url"))
        XCTAssertNil(HubAddress.normalise("mailto:someone@example.com"))
        XCTAssertEqual(HubAddress.realtimeURL(for: URL(string: "https://hub.example.com")!)?.absoluteString, "wss://hub.example.com/rt/?EIO=4&transport=websocket")
        XCTAssertEqual(HubAddress.realtimeURL(for: URL(string: "http://10.0.0.2:8080/hub")!)?.absoluteString, "ws://10.0.0.2:8080/hub/rt/?EIO=4&transport=websocket")
    }

    func testTokenRefreshTiming() {
        var credentials = Credentials(
            hubURL: URL(string: "https://h")!, kind: .password, accessToken: "a", refreshToken: "r",
            accessExpiresAt: now.addingTimeInterval(20), renewedAt: nil, userID: "u", username: "t",
            displayName: "T", role: "owner", profiles: ["default", "work"], defaultProfile: "work"
        )
        XCTAssertTrue(credentials.needsRefresh(now: now))
        credentials.accessExpiresAt = now.addingTimeInterval(600)
        XCTAssertFalse(credentials.needsRefresh(now: now))
        XCTAssertFalse(credentials.needsRenewal(now: now))

        credentials.kind = .device
        credentials.renewedAt = now.addingTimeInterval(-3600)
        XCTAssertFalse(credentials.needsRenewal(now: now))
        credentials.renewedAt = now.addingTimeInterval(-90_000)
        XCTAssertTrue(credentials.needsRenewal(now: now))
    }

    func testTheAppOpensOnAProfileThePersonMayEnter() {
        let credentials = Credentials(
            hubURL: URL(string: "https://h")!, kind: .password, accessToken: "a", refreshToken: nil,
            accessExpiresAt: nil, renewedAt: nil, userID: "u", username: "t", displayName: "T",
            role: "member", profiles: ["work", "home"], defaultProfile: "default"
        )
        XCTAssertEqual(AppModel.pickProfile(remembered: "home", credentials: credentials), "home")
        XCTAssertEqual(AppModel.pickProfile(remembered: "gone", credentials: credentials), "work")
        var withDefault = credentials
        withDefault.profiles = ["default", "work"]
        XCTAssertEqual(AppModel.pickProfile(remembered: nil, credentials: withDefault), "default")
    }
}
