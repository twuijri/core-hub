import Foundation
import XCTest
@testable import HermesStudio

/// The three bugs the owner hit on a device:
///
/// 1. opening the drawer left the keyboard covering it,
/// 2. every transcript row came back blank because `display_content` may be
///    JSON `null` (the same class of bug that printed "null" on Android),
/// 3. a session id the server no longer knows produced a stack of red
///    "Session not found" rows.
///
/// The fixtures below are parsed from real JSON text so `null` arrives as
/// `NSNull`, exactly as `JSONSerialization` hands it to the app.
final class ChatBugfixTests: XCTestCase {
    private func object(_ text: String) throws -> JSON {
        let data = try XCTUnwrap(text.data(using: .utf8))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? JSON)
    }

    private func messagePage(_ text: String) throws -> MessagePage {
        MessagePage(try object(text))
    }

    // MARK: - Bug 1: the drawer and the keyboard

    func testKeyboardOverlapTakesOffTheSafeAreaTheLayoutAlreadyReserves() {
        XCTAssertEqual(Keyboard.overlap(keyboardHeight: 336, bottomSafeArea: 34), 302)
        XCTAssertEqual(Keyboard.overlap(keyboardHeight: 291, bottomSafeArea: 0), 291)
        // A hidden keyboard, and a safe area larger than the keyboard, both
        // mean "reserve nothing" rather than a negative inset.
        XCTAssertEqual(Keyboard.overlap(keyboardHeight: 0, bottomSafeArea: 34), 0)
        XCTAssertEqual(Keyboard.overlap(keyboardHeight: 20, bottomSafeArea: 34), 0)
        XCTAssertEqual(Keyboard.overlap(keyboardHeight: -10, bottomSafeArea: 0), 0)
    }

    // MARK: - Bug 2: transcript parity with the server

    func testNullDisplayContentFallsBackToTheStoredContent() throws {
        let page = try messagePage("""
        {"session":{"title":"معرفة نوع جهاز الماك"},"total":2,"offset":0,"hasMore":false,
         "messages":[
           {"id":"m1","role":"user","display_content":null,"content":"وش نوع جهازي؟"},
           {"id":"m2","role":"assistant","display_content":null,
            "content":[{"type":"text","text":"جهازك ماك"}]}
         ]}
        """)
        XCTAssertEqual(page.messages.map(\.content), ["وش نوع جهازي؟", "جهازك ماك"])
        XCTAssertEqual(Message.transcriptRows(page.messages).map { $0.kind }, [.user, .assistant])
    }

    func testDisplayContentWinsWhenTheServerSendsOne() throws {
        let page = try messagePage("""
        {"messages":[{"id":"m1","role":"assistant","display_content":"shown","content":"raw"}]}
        """)
        XCTAssertEqual(page.messages.map(\.content), ["shown"])
    }

    func testAnEmptyDisplayContentStillWinsOverContentLikeTheWebNullishFallback() throws {
        // The web is `msg.display_content ?? msg.content`: only null and
        // undefined fall through, an empty string does not.
        let page = try messagePage("""
        {"messages":[{"id":"m1","role":"assistant","display_content":"","content":"raw"}]}
        """)
        XCTAssertEqual(page.messages.map(\.content), [""])
        XCTAssertTrue(Message.transcriptRows(page.messages).isEmpty)
    }

    func testARowWithNothingToShowIsDroppedInsteadOfDrawingAnEmptyBubble() throws {
        let page = try messagePage("""
        {"messages":[
          {"id":"m1","role":"assistant","display_content":null,"content":null},
          {"id":"m2","role":"assistant","display_content":null,"content":"   "},
          {"id":"m3","role":"assistant","content":"kept"}
        ]}
        """)
        XCTAssertEqual(page.messages.count, 3)
        let rows = Message.transcriptRows(page.messages)
        XCTAssertEqual(rows.map { $0.message.id }, ["m3"])
        XCTAssertEqual(rows.map { $0.message.content }, ["kept"])
    }

    func testAttachmentOnlyAndReasoningOnlyRowsSurvive() throws {
        let page = try messagePage("""
        {"messages":[
          {"id":"m1","role":"user","display_content":null,
           "content":[{"type":"image","path":"/uploads/a.png","name":"a.png","media_type":"image/png"}]},
          {"id":"m2","role":"assistant","display_content":null,"content":"","reasoning":"thinking"}
        ]}
        """)
        let rows = Message.transcriptRows(page.messages)
        XCTAssertEqual(rows.map { $0.message.id }, ["m1", "m2"])
        XCTAssertEqual(rows.first?.message.attachments.map(\.name), ["a.png"])
    }

    func testToolRowsStayOutOfTheTranscriptAndMoaBecomesASystemNote() throws {
        let page = try messagePage("""
        {"messages":[
          {"id":"m1","role":"user","display_role":"user","display_content":null,"content":"اسأل"},
          {"id":"m2","role":"tool","display_role":"tool","display_content":null,
           "content":"{\\"ok\\":true,\\"stdout\\":\\"total 0\\"}","tool_name":"terminal"},
          {"id":"m3","role":"assistant","display_role":"moa","display_content":"اتفق النموذجان","content":"raw"},
          {"id":"m4","role":"assistant","display_role":"assistant","display_content":null,"content":"الجواب"}
        ]}
        """)
        XCTAssertEqual(page.messages.map(\.displayRole), ["user", "tool", "moa", "assistant"])
        let rows = Message.transcriptRows(page.messages)
        XCTAssertEqual(rows.map { $0.message.id }, ["m1", "m3", "m4"])
        XCTAssertEqual(rows.map { $0.kind }, [.user, .system, .assistant])
        XCTAssertEqual(rows.map { $0.message.content }, ["اسأل", "اتفق النموذجان", "الجواب"])
    }

    func testDisplayRoleOverridesTheStoredRoleLikeTheWeb() throws {
        let json = try object("""
        {"id":"m1","role":"assistant","display_role":"command","content":"/fork"}
        """)
        let message = Message(json)
        XCTAssertEqual(message.role, "assistant")
        XCTAssertEqual(message.displayRole, "command")
        XCTAssertEqual(message.transcriptKind, .command)
    }

    func testANullRoleFallsBackToAssistantRatherThanBreakingTheRow() throws {
        let json = try object("""
        {"id":"m1","role":null,"display_role":null,"content":"hi"}
        """)
        XCTAssertEqual(Message(json).transcriptKind, .assistant)
    }

    // MARK: - Bug 3: a session the server no longer has

    func testSessionGoneIsRecognisedFromTheServerWording() {
        XCTAssertTrue(ChatRunReducer.isSessionGone("Session not found"))
        XCTAssertTrue(ChatRunReducer.isSessionGone("Conversation not found"))
        XCTAssertTrue(ChatRunReducer.isSessionGone("HTTP 404: Session not found"))
        XCTAssertFalse(ChatRunReducer.isSessionGone("Run failed"))
        XCTAssertFalse(ChatRunReducer.isSessionGone("Profile \"main\" is not available for this user"))
    }

    func testAGoneSessionShowsOneEmptyStateInsteadOfARedRowPerAttempt() {
        var state = ChatStreamState()
        // Every reconnect re-sends `app.resume`, so the failure repeats.
        for _ in 0..<5 {
            ChatRunReducer.apply(.failed("Session not found", retryable: false), to: &state, sender: "Hermes")
        }
        XCTAssertTrue(state.lines.isEmpty)
        XCTAssertTrue(state.sessionMissing)
        XCTAssertFalse(state.isRunning)
    }

    func testAGoneSessionRemovesTheEmptyStreamingReplyItInterrupted() {
        var state = ChatStreamState()
        ChatRunReducer.beginRun(&state, text: "مرحبا", attachments: [], sender: "Hermes")
        XCTAssertEqual(state.lines.count, 2)
        ChatRunReducer.apply(.failed("Session not found", retryable: false), to: &state, sender: "Hermes")
        XCTAssertEqual(state.lines.map(\.kind), [.user])
        XCTAssertNil(state.activeReplyID)
        XCTAssertTrue(state.sessionMissing)
    }

    func testTheNextRunClearsTheEmptyStateSoASessionIsCreatedAgain() {
        var state = ChatStreamState()
        ChatRunReducer.apply(.failed("Session not found", retryable: false), to: &state, sender: "Hermes")
        XCTAssertTrue(state.sessionMissing)
        ChatRunReducer.beginRun(&state, text: "again", attachments: [], sender: "Hermes")
        XCTAssertFalse(state.sessionMissing)
    }

    func testARepeatedFailureDoesNotStackIdenticalErrorRows() {
        var state = ChatStreamState()
        ChatRunReducer.apply(.failed("Run failed", retryable: false), to: &state, sender: "Hermes")
        ChatRunReducer.apply(.failed("Run failed", retryable: false), to: &state, sender: "Hermes")
        XCTAssertEqual(state.lines.count, 1)
        XCTAssertEqual(state.lines.first?.kind, .error)
        // A different failure is still worth a row.
        ChatRunReducer.apply(.failed("Model unavailable", retryable: false), to: &state, sender: "Hermes")
        XCTAssertEqual(state.lines.map(\.text), ["Run failed", "Model unavailable"])
    }

    func testAMissingSessionIsRecognisedFromTheRestError() {
        XCTAssertTrue(ConversationView.isMissingSession(HermesError.http(404, "Conversation not found")))
        XCTAssertTrue(ConversationView.isMissingSession(HermesError.http(404, "")))
        XCTAssertTrue(ConversationView.isMissingSession(HermesError.server("Session not found")))
        XCTAssertFalse(ConversationView.isMissingSession(HermesError.http(500, "boom")))
        XCTAssertFalse(ConversationView.isMissingSession(HermesError.malformedResponse))
    }

    func testANewChatIsALocalDraftUntilItsFirstRun() {
        let draft = SessionSummary.draft(agent: "hermes", profile: "main", model: "gpt-5", id: "new-1")
        XCTAssertTrue(draft.isLocalDraft)
        XCTAssertEqual(draft.id, "new-1")
        XCTAssertEqual(draft.source, "cli")
        // Anything that came back from the server is not a draft.
        XCTAssertFalse(SessionSummary(["id": "s1", "title": "من الخادم"]).isLocalDraft)
    }

    func testThePerSessionSocketEventsWaitUntilTheServerKnowsTheSession() {
        let socket = ChatSocket()
        // A fresh socket has not been told the session exists, so nothing
        // that would be answered with "Session not found" may go out.
        XCTAssertFalse(socket.sessionExists)
        // `run` is the only event that creates the session; with no
        // connection it reports that it could not send.
        XCTAssertFalse(socket.run(["session_id": "s1", "input": "hi"]))
        socket.markSessionExists()
        XCTAssertTrue(socket.sessionExists)
        socket.markSessionGone()
        XCTAssertFalse(socket.sessionExists)
    }
}
