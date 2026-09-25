// The realtime envelope (packages/contracts/events/README.md §Envelope) and the `/rt/sessions`
// events a chat reads, decoded into the generated models so HTTP and realtime share one shape.
import CoreHubClient
import Foundation

struct Envelope {
    let event: String
    let namespace: String
    let profile: String?
    let seq: Int
    /// The payload object as JSON, decoded per event.
    let payload: Data

    static func parse(_ data: Data?) -> Envelope? {
        guard let data,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let event = object["event"] as? String,
              let namespace = object["namespace"] as? String,
              let seq = (object["seq"] as? NSNumber)?.intValue,
              let payload = object["payload"] as? [String: Any],
              let payloadData = try? JSONSerialization.data(withJSONObject: payload)
        else { return nil }
        return Envelope(event: event, namespace: namespace, profile: object["profile"] as? String, seq: seq, payload: payloadData)
    }
}

/// The generated client's own decoder (its date format), shared by the realtime code.
enum HubJSON {
    static let decoder: JSONDecoder = CodableHelper().jsonDecoder
}

enum SessionEvent {
    case sessionCreated(Session)
    case sessionUpdated(Session)
    case sessionDeleted(sessionID: String)
    case messageCreated(Message)
    case messageDelta(sessionID: String, messageID: String, runID: String, delta: String)
    case reasoningDelta(sessionID: String, messageID: String, runID: String, delta: String)
    case tool(sessionID: String, messageID: String, runID: String, call: ToolCall)
    case run(Run, ended: RunEnd?)
    case runCompleted(Run, Message)
    case approvalRequested(Approval)
    case approvalResolved(Approval)
    case contextUpdated(sessionID: String, context: ContextUsage?)

    enum RunEnd {
        case failed
        case cancelled
    }

    /// The session the event is about; `nil` when it names none.
    var sessionID: String? {
        switch self {
        case .sessionCreated(let s), .sessionUpdated(let s): return s.id
        case .sessionDeleted(let id): return id
        case .messageCreated(let m): return m.sessionId
        case .messageDelta(let id, _, _, _), .reasoningDelta(let id, _, _, _): return id
        case .tool(let id, _, _, _): return id
        case .run(let run, _): return run.sessionId
        case .runCompleted(let run, _): return run.sessionId
        case .approvalRequested(let a), .approvalResolved(let a): return a.sessionId
        case .contextUpdated(let id, _): return id
        }
    }

    static func decode(_ envelope: Envelope) -> SessionEvent? {
        let d = HubJSON.decoder
        let data = envelope.payload
        switch envelope.event {
        case "session.created":
            return (try? d.decode(SessionBox.self, from: data)).map { .sessionCreated($0.session) }
        case "session.updated":
            return (try? d.decode(SessionBox.self, from: data)).map { .sessionUpdated($0.session) }
        case "session.deleted":
            return (try? d.decode(IDBox.self, from: data)).map { .sessionDeleted(sessionID: $0.session_id) }
        case "message.created":
            return (try? d.decode(MessageBox.self, from: data)).map { .messageCreated($0.message) }
        case "message.delta", "reasoning.delta":
            guard let p = try? d.decode(DeltaBox.self, from: data) else { return nil }
            return envelope.event == "message.delta"
                ? .messageDelta(sessionID: p.session_id, messageID: p.message_id, runID: p.run_id, delta: p.delta)
                : .reasoningDelta(sessionID: p.session_id, messageID: p.message_id, runID: p.run_id, delta: p.delta)
        case "tool.started", "tool.completed", "tool.failed":
            guard let p = try? d.decode(ToolBox.self, from: data) else { return nil }
            return .tool(sessionID: p.session_id, messageID: p.message_id, runID: p.run_id, call: p.tool_call)
        case "run.queued", "run.started":
            return (try? d.decode(RunBox.self, from: data)).map { .run($0.run, ended: nil) }
        case "run.failed":
            return (try? d.decode(RunBox.self, from: data)).map { .run($0.run, ended: .failed) }
        case "run.cancelled":
            return (try? d.decode(RunBox.self, from: data)).map { .run($0.run, ended: .cancelled) }
        case "run.completed":
            guard let p = try? d.decode(RunCompletedBox.self, from: data) else { return nil }
            return .runCompleted(p.run, p.message)
        case "approval.requested":
            return (try? d.decode(ApprovalBox.self, from: data)).map { .approvalRequested($0.approval) }
        case "approval.resolved":
            return (try? d.decode(ApprovalBox.self, from: data)).map { .approvalResolved($0.approval) }
        case "context.updated":
            guard let p = try? d.decode(ContextBox.self, from: data) else { return nil }
            return .contextUpdated(sessionID: p.session_id, context: p.context)
        default:
            return nil
        }
    }

    private struct SessionBox: Decodable { let session: Session }
    private struct IDBox: Decodable { let session_id: String }
    private struct MessageBox: Decodable { let message: Message }
    private struct DeltaBox: Decodable {
        let session_id: String
        let message_id: String
        let run_id: String
        let delta: String
    }
    private struct ToolBox: Decodable {
        let session_id: String
        let message_id: String
        let run_id: String
        let tool_call: ToolCall
    }
    private struct RunBox: Decodable { let run: Run }
    private struct RunCompletedBox: Decodable {
        let run: Run
        let message: Message
    }
    private struct ApprovalBox: Decodable { let approval: Approval }
    private struct ContextBox: Decodable {
        let session_id: String
        let context: ContextUsage?
    }
}

/// Every event name `/rt/sessions` carries.
enum SessionEvents {
    static let names: Set<String> = [
        "session.created", "session.updated", "session.deleted",
        "message.created", "message.delta", "reasoning.delta",
        "tool.started", "tool.completed", "tool.failed",
        "run.queued", "run.started", "run.completed", "run.failed", "run.cancelled",
        "approval.requested", "approval.resolved", "context.updated",
    ]
}
