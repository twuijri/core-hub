@testable import CoreHub
import CoreHubClient
import XCTest

/// Writing into a Telegram or WhatsApp conversation from the phone (contract decision §153): the
/// new fields read with and without them (an older hub), the composer or the reason in its place,
/// the hub's message followed from posted to answered, the realtime event, the polling that slows
/// down while the hub announces each turn, and a refused send in the screen's words.
final class ChannelSendTests: XCTestCase {
    private let at = "2026-10-08T10:00:00Z"
    private let ulid = "01K6ZQ4W5X6Y7Z8A9B0C1D2E3F"
    private let ulid2 = "01K6ZQ4W5X6Y7Z8A9B0C1D2E3G"

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try HubJSON.decoder.decode(type, from: Data(json.utf8))
    }

    private func conversation(_ extra: String = "") throws -> ChannelConversation {
        try decode(ChannelConversation.self, """
        {"id":"T1","profile":"work","channel":"telegram","message_count":3,"started_at":"\(at)","last_message_at":"\(at)",
         "peer_name":"Sara","preview":"hi"\(extra)}
        """)
    }

    private func outgoingJSON(_ id: String, _ status: String, messageID: String? = nil, client: String? = "i-1", error: String = "null") -> String {
        """
        {"id":"\(id)","conversation_id":"T1","client_message_id":\(client.map { "\"\($0)\"" } ?? "null"),"text":"ما آخر الأخبار؟",
         "author_name":"Admin","status":"\(status)","error":\(error),"message_id":\(messageID.map { "\"\($0)\"" } ?? "null"),
         "session_id":null,"created_at":"\(at)","updated_at":"\(at)"}
        """
    }

    private func outgoing(_ id: String, _ status: String, messageID: String? = nil, client: String? = "i-1") throws -> ChannelOutgoing {
        try decode(ChannelOutgoing.self, outgoingJSON(id, status, messageID: messageID, client: client))
    }

    private func message(_ id: String, role: ChannelMessage.Role = .user, origin: ChannelMessage.Origin? = nil) -> ChannelMessage {
        ChannelMessage(id: id, role: role, text: "t", createdAt: Fixture.date, origin: origin)
    }

    private func object(_ json: String) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    }

    // MARK: - Reading

    func testAnOlderHubWithoutTheNewFieldsReadsAsBefore() throws {
        let old = try conversation()
        XCTAssertNil(old.canSend)
        XCTAssertNil(old.sendUnavailable)
        XCTAssertEqual(ChannelSendRules.bottom(old), .readOnly)
        let page = try decode(SessionsListChannelMessages200Response.self, """
        {"conversation":{"id":"T1","profile":"work","channel":"telegram","message_count":1,"started_at":"\(at)","last_message_at":"\(at)"},
         "items":[{"id":"m1","role":"user","text":"hi","created_at":"\(at)"}],"has_more":false,"next_offset":null}
        """)
        XCTAssertNil(page.outgoing)
        XCTAssertNil(page.liveUpdates)
        XCTAssertNil(page.items[0].origin, "absent origin means the channel")
        XCTAssertFalse(ChannelSendRules.fromHub(page.items[0]))
        XCTAssertEqual(ChannelSendRules.transcriptPoll(live: page.liveUpdates), 30_000_000_000)
        XCTAssertEqual(ChannelSendRules.listPoll(live: nil), 45_000_000_000)
    }

    func testANewerHubGivesTheComposerOrTheReason() throws {
        XCTAssertEqual(ChannelSendRules.bottom(try conversation(#","can_send":true,"send_unavailable":null,"current_id":null"#)), .composer)
        XCTAssertEqual(
            ChannelSendRules.bottom(try conversation(#","can_send":false,"send_unavailable":"not_admin","current_id":null"#)),
            .unavailable(.notAdmin, currentID: nil)
        )
        XCTAssertEqual(
            ChannelSendRules.bottom(try conversation(#","can_send":false,"send_unavailable":"not_current","current_id":"T2""#)),
            .unavailable(.notCurrent, currentID: "T2"),
            "a conversation that moved on carries where to go"
        )
        XCTAssertEqual(
            ChannelSendRules.bottom(try conversation(#","can_send":false,"send_unavailable":"hermes_not_managed","current_id":null"#)),
            .readOnly,
            "a hub that does not run Hermes keeps the read-only banner"
        )
        for reason in ["platform_unsupported", "bridge_offline", "no_route"] {
            let bottom = ChannelSendRules.bottom(try conversation(",\"can_send\":false,\"send_unavailable\":\"\(reason)\",\"current_id\":null"))
            XCTAssertEqual(bottom, .unavailable(ChannelSendUnavailable(rawValue: reason)!, currentID: nil))
        }
    }

    func testTheHubsMessageTheOutgoingListAndLiveUpdatesAreRead() throws {
        let page = try decode(SessionsListChannelMessages200Response.self, """
        {"conversation":{"id":"T1","profile":"work","channel":"telegram","message_count":2,"started_at":"\(at)","last_message_at":"\(at)","can_send":true},
         "items":[{"id":"m1","role":"user","text":"ما آخر الأخبار؟","created_at":"\(at)","attachments":[],"origin":"hub","author_name":"Admin"},
                  {"id":"m2","role":"assistant","text":"Here","created_at":"\(at)","attachments":[],"origin":"channel","author_name":null}],
         "has_more":false,"next_offset":null,"outgoing":[\(outgoingJSON(ulid, "answering", messageID: "m1"))],"live_updates":true}
        """)
        XCTAssertTrue(ChannelSendRules.fromHub(page.items[0]))
        XCTAssertEqual(page.items[0].authorName, "Admin")
        XCTAssertFalse(ChannelSendRules.fromHub(page.items[1]))
        XCTAssertEqual(page.outgoing?.first?.status, .answering)
        XCTAssertEqual(ChannelSendRules.transcriptPoll(live: page.liveUpdates), ChannelSendRules.liveTranscriptEvery)
        let list = try decode(SessionsListChannelConversations200Response.self, #"{"items":[],"unavailable":[],"has_more":false,"live_updates":true}"#)
        XCTAssertEqual(ChannelSendRules.listPoll(live: list.liveUpdates), ChannelSendRules.liveListEvery)
        let failed = try decode(ChannelOutgoing.self, outgoingJSON(ulid, "failed", error: #"{"reason":"bridge_no_answer","message":null}"#))
        XCTAssertEqual(failed.error?.reason, .bridgeNoAnswer)
    }

    // MARK: - Following the message

    func testAMessageTheTranscriptHasShowsItsStateUnderItAndOneItHasNotComesAfter() throws {
        let messages = [message("m1", origin: .hub), message("m2", role: .assistant)]
        let split = ChannelSendRules.split(messages, [try outgoing(ulid, "answering", messageID: "m1"), try outgoing(ulid2, "posted", client: "i-2")])
        XCTAssertEqual(Set(split.followed.keys), ["m1"])
        XCTAssertEqual(split.pending.map(\.id), [ulid2])
        let notShown = ChannelSendRules.split(messages, [try outgoing(ulid, "answered", messageID: "m9")])
        XCTAssertEqual(notShown.pending.map(\.id), [ulid], "a message on a page not read is still drawn after the rest")
    }

    func testTheWordsShowAtOnceUntilTheHubsCopyTakesTheirPlace() throws {
        let sending = ChannelSending(key: "i-1", text: "ما آخر الأخبار؟")
        XCTAssertTrue(ChannelSendRules.showSending(sending, pending: []))
        XCTAssertFalse(ChannelSendRules.showSending(sending, pending: [try outgoing(ulid, "posted", client: "i-1")]))
        XCTAssertTrue(ChannelSendRules.showSending(sending, pending: [try outgoing(ulid, "posted", client: "other")]))
        XCTAssertFalse(ChannelSendRules.showSending(nil, pending: []))
    }

    func testTheStateMovesInPlaceFromPostedToAnswered() throws {
        var list = ChannelSendRules.upsert([], try outgoing(ulid, "posted"))
        for status in ["delivered", "answering", "answered"] {
            list = ChannelSendRules.upsert(list, try outgoing(ulid, status))
            XCTAssertEqual(list.count, 1)
            XCTAssertEqual(list[0].status.rawValue, status)
        }
        list = ChannelSendRules.upsert(list, try outgoing(ulid2, "posted", client: "i-2"))
        XCTAssertEqual(list.map(\.id), [ulid, ulid2])
    }

    func testTheStatusLineSaysWhatBecameOfTheMessage() throws {
        let l10n = L10n(.en, bundle: Bundle(for: AppModel.self))
        XCTAssertEqual(ChannelSendRules.statusLine(nil, channel: "Telegram", l10n)?.text, "Sending on Telegram…")
        XCTAssertEqual(ChannelSendRules.statusLine(try outgoing(ulid, "answering"), channel: "Telegram", l10n)?.text, "The agent is answering on Telegram…")
        XCTAssertNil(ChannelSendRules.statusLine(try outgoing(ulid, "answered"), channel: "Telegram", l10n), "nothing once answered")
        let failed = try decode(ChannelOutgoing.self, outgoingJSON(ulid, "failed", error: #"{"reason":"not_accepted","message":"route changed"}"#))
        let line = try XCTUnwrap(ChannelSendRules.statusLine(failed, channel: "Telegram", l10n))
        XCTAssertTrue(line.failed)
        XCTAssertEqual(line.text, "Posted on Telegram, but Hermes refused to hand it to the agent. (route changed)")
        let arabic = L10n(.ar, bundle: Bundle(for: AppModel.self))
        XCTAssertEqual(arabic("channel_send.from_hub", ["name": "Sara"]), "Sara · من كور هب")
    }

    func testTheWordsToSendAreTrimmedAndCapped() {
        XCTAssertNil(ChannelSendRules.words("  \n "))
        XCTAssertEqual(ChannelSendRules.words("  hi \n"), "hi")
        XCTAssertEqual(ChannelSendRules.words(String(repeating: "x", count: 5000))?.count, ChannelSendRules.textMax)
    }

    @MainActor
    func testEachMessageHasItsOwnClientID() {
        XCTAssertNotEqual(ChannelSendRules.clientID(), ChannelSendRules.clientID())
    }

    func testAHubMessageStartsItsOwnTurn() {
        let person = message("m1"), hub = message("m2", origin: .hub), hub2 = message("m3", origin: .hub)
        XCTAssertTrue(ChannelSendRules.startsTurn(nil, person))
        XCTAssertTrue(ChannelSendRules.startsTurn(person, hub))
        XCTAssertFalse(ChannelSendRules.startsTurn(hub, hub2))
        XCTAssertFalse(ChannelSendRules.startsTurn(person, message("m4")))
    }

    // MARK: - Realtime

    private func update(_ reason: String, _ status: String? = nil, conversation: String = "T1") -> ChannelUpdate? {
        var payload: [String: Any] = ["conversation_id": conversation, "channel": "telegram", "reason": reason, "outgoing": NSNull()]
        if let status { payload["outgoing"] = object(outgoingJSON(ulid, status)) }
        return ChannelSendRules.parse(Fixture.envelope("channel_conversation.updated", seq: 7, profile: "work", payload: payload))
    }

    func testChannelConversationUpdatedIsReadAndNothingElseIs() throws {
        let turn = try XCTUnwrap(update("turn_started"))
        XCTAssertEqual(turn.conversationID, "T1")
        XCTAssertEqual(turn.reason, "turn_started")
        XCTAssertNil(turn.outgoing)
        XCTAssertEqual(try XCTUnwrap(update("outgoing", "delivered")).outgoing?.status, .delivered)
        XCTAssertNil(ChannelSendRules.parse(Fixture.envelope("session.updated", seq: 8, payload: ["session_id": "S1"])))
        XCTAssertNil(ChannelSendRules.parse(Fixture.envelope("channel_conversation.updated", seq: 9, payload: ["conversation_id": "T1"])), "no reason, no update")
    }

    func testAStepInBetweenMovesTheLineAndATurnOrTheEndReadsAgain() throws {
        let start = [try outgoing(ulid, "posted")]
        let delivered = ChannelSendRules.apply(conversationID: "T1", outgoing: start, update: try XCTUnwrap(update("outgoing", "delivered")))
        XCTAssertEqual(delivered.outgoing.first?.status, .delivered)
        XCTAssertFalse(delivered.refetch)
        XCTAssertTrue(ChannelSendRules.apply(conversationID: "T1", outgoing: delivered.outgoing, update: try XCTUnwrap(update("turn_started"))).refetch)
        XCTAssertTrue(ChannelSendRules.apply(conversationID: "T1", outgoing: delivered.outgoing, update: try XCTUnwrap(update("turn_ended"))).refetch)
        let answered = ChannelSendRules.apply(conversationID: "T1", outgoing: delivered.outgoing, update: try XCTUnwrap(update("outgoing", "answered")))
        XCTAssertTrue(answered.refetch)
        XCTAssertEqual(answered.outgoing.first?.status, .answered)
        XCTAssertTrue(ChannelSendRules.apply(conversationID: "T1", outgoing: start, update: try XCTUnwrap(update("outgoing", "failed"))).refetch)
        let elsewhere = ChannelSendRules.apply(conversationID: "T9", outgoing: start, update: try XCTUnwrap(update("turn_ended")))
        XCTAssertFalse(elsewhere.refetch, "another conversation's turn is not this screen's")
        XCTAssertEqual(elsewhere.outgoing, start)
        XCTAssertTrue(ChannelSendRules.settled(try XCTUnwrap(update("turn_ended"))))
        XCTAssertFalse(ChannelSendRules.settled(try XCTUnwrap(update("outgoing", "answering"))))
    }

    // MARK: - Refusals

    private func failure(_ status: Int, _ body: String) -> HubFailure {
        HubFailure(ErrorResponse.error(status, Data(body.utf8), nil, NSError(domain: "test", code: status)))
    }

    func testARefusedSendIsSaidInTheScreensWords() {
        XCTAssertEqual(
            ChannelSendRules.refusal(failure(503, #"{"error":"Telegram refused","code":"service_unavailable","details":{"reason":"channel_send_failed","message":"Bad Request: chat not found"}}"#)),
            .channel("Bad Request: chat not found")
        )
        XCTAssertEqual(ChannelSendRules.refusal(failure(503, #"{"error":"x","code":"service_unavailable","details":{"reason":"bridge_offline"}}"#)), .unavailable(.bridgeOffline))
        XCTAssertEqual(ChannelSendRules.refusal(failure(409, #"{"error":"x","code":"state_invalid","details":{"reason":"not_current","current_id":"T2"}}"#)), .unavailable(.notCurrent))
        XCTAssertEqual(ChannelSendRules.refusal(failure(403, #"{"error":"x","code":"forbidden","details":{"reason":"not_admin"}}"#)), .unavailable(.notAdmin))
        guard case .other(let other) = ChannelSendRules.refusal(failure(400, #"{"error":"Too long","code":"validation_failed"}"#)) else {
            return XCTFail("a validation error is the hub's own sentence")
        }
        XCTAssertEqual(other.message, "Too long")
        let l10n = L10n(.en, bundle: Bundle(for: AppModel.self))
        XCTAssertEqual(
            ChannelSendRules.refusalText(.channel("chat not found"), channel: "Telegram", l10n),
            "Telegram refused the message, so it did not reach the agent: chat not found"
        )
        XCTAssertEqual(
            ChannelSendRules.unavailableText(.notCurrent, channel: "Telegram", l10n),
            "This Telegram chat has moved on to a newer conversation; a message from here would go there."
        )
    }
}
