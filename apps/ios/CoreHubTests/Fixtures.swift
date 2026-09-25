@testable import CoreHub
import CoreHubClient
import Foundation
import XCTest

/// Builders for the generated models, so each test states only what it is about.
enum Fixture {
    static let date = Date(timeIntervalSince1970: 1_790_000_000)

    static func message(
        id: String,
        seq: Int,
        role: MessageRole = .assistant,
        text: String? = nil,
        runID: String? = "run1",
        status: MessageStatus = .complete,
        author: String = "Hermes",
        profile: String = "default",
        session: String = "s1"
    ) -> Message {
        Message(
            id: id,
            profile: profile,
            ownerId: "u1",
            createdAt: date,
            updatedAt: date,
            sessionId: session,
            seq: seq,
            role: role,
            author: Author(kind: role == .user ? .user : .agent, name: author),
            content: text.map { [.typeTextBlock(TextBlock(type: .text, text: $0))] } ?? [],
            toolCalls: [],
            runId: runID,
            status: status,
            mentions: []
        )
    }

    static func run(id: String = "run1", status: RunStatus, session: String = "s1", created: Date = date) -> Run {
        Run(
            id: id,
            profile: "default",
            ownerId: "u1",
            createdAt: created,
            updatedAt: created,
            sessionId: session,
            jobId: "job-\(id)",
            status: status,
            trigger: RunTrigger(kind: .user),
            interrupted: false
        )
    }

    static func approval(id: String = "a1", status: ApprovalStatus = .pending, kind: ApprovalKind = .toolCall, session: String = "s1", allowAlways: Bool = false, choices: [Choice] = []) -> Approval {
        Approval(
            id: id,
            profile: "default",
            ownerId: "u1",
            createdAt: date,
            updatedAt: date,
            kind: kind,
            status: status,
            sessionId: session,
            agent: AgentRef(id: "ag1", name: "Hermes"),
            title: "Run a command",
            choices: choices,
            allowAlways: allowAlways,
            answerMode: .choice
        )
    }

    static func tool(id: String = "t1", status: ToolCallStatus, output: String? = nil) -> ToolCall {
        ToolCall(id: id, name: "shell", status: status, preview: "ls", output: output, outputTruncated: false)
    }

    /// An envelope as the hub sends it, through the same parser the app uses.
    static func envelope(_ event: String, seq: Int, profile: String? = "default", payload: [String: Any]) -> Envelope {
        let object: [String: Any] = [
            "event": event,
            "namespace": "/rt/sessions",
            "profile": profile as Any,
            "ts": "2026-09-25T10:00:00Z",
            "seq": seq,
            "payload": payload,
        ]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return Envelope.parse(data)!
    }

    /// A generated model as the JSON object the hub would send.
    static func json<T: Encodable>(_ value: T) -> [String: Any] {
        let data = try! CodableHelper().jsonEncoder.encode(value)
        return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    /// The test bundle's copy of a repository file (project.yml copies them at build time).
    static func repositoryFile(_ name: String, _ ext: String) throws -> Data {
        let bundle = Bundle(for: BundleToken.self)
        let url = try XCTUnwrap(bundle.url(forResource: name, withExtension: ext), "\(name).\(ext) is not in the test bundle")
        return try Data(contentsOf: url)
    }
}

private final class BundleToken {}
