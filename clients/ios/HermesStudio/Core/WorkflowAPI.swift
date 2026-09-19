import Foundation

/// M4 workflow routes beyond the M1 set (`packages/client/src/api/studio/workflows.ts`).
extension APIClient {
    /// `GET /workflows/{id}/runs/{runId}` — one run with node sessions,
    /// edge evaluations and loop epochs.
    func workflowRun(_ id: String, runID: String) async throws -> WorkflowRun {
        let root = try await object("/api/studio/workflows/\(id.urlEncoded)/runs/\(runID.urlEncoded)")
        return WorkflowRun(root.object("run").isEmpty ? root : root.object("run"))
    }

    /// `PATCH /workflows/{id}/schedules/{scheduleId} { enabled }` — the
    /// enable/disable switch of the schedules list.
    func setWorkflowScheduleEnabled(workflowID: String, scheduleID: String, enabled: Bool) async throws {
        _ = try await object("/api/studio/workflows/\(workflowID.urlEncoded)/schedules/\(scheduleID.urlEncoded)", method: "PATCH", body: ["enabled": enabled])
    }

    /// `POST /workflows/{id}/run { input?, start_node_ids?, timeout_ms? }`.
    func runWorkflow(_ id: String, input: String?, startNodeIDs: [String], timeoutMs: Int?) async throws {
        var body: JSON = [:]
        if let input = input?.nilIfEmpty { body["input"] = input }
        if !startNodeIDs.isEmpty { body["start_node_ids"] = startNodeIDs }
        if let timeoutMs, timeoutMs > 0 { body["timeout_ms"] = timeoutMs }
        _ = try await object("/api/studio/workflows/\(id.urlEncoded)/run", method: "POST", body: body)
    }
}

/// Status → chip colour/label mapping shared by the list and the run screen
/// (web `WorkflowRuntimeState`).
enum WorkflowStatusStyle {
    enum Tone: Equatable { case neutral, info, success, warning, error }

    static func tone(for status: String) -> Tone {
        switch status {
        case "running", "queued": return .info
        case "completed": return .success
        case "pending_approval", "blocked", "skipped": return .warning
        case "failed", "approval_rejected", "canceled", "cancelled", "timed_out": return .error
        default: return .neutral
        }
    }

    static func label(for status: String) -> String {
        switch status {
        case "idle": return String(localized: "Idle")
        case "queued": return String(localized: "Queued")
        case "running": return String(localized: "Running")
        case "pending_approval", "blocked": return String(localized: "Awaiting approval")
        case "completed": return String(localized: "Completed")
        case "skipped": return String(localized: "Skipped")
        case "failed": return String(localized: "Failed")
        case "approval_rejected": return String(localized: "Rejected")
        case "canceled", "cancelled": return String(localized: "Canceled")
        case "timed_out": return String(localized: "Timed out")
        default: return status.isEmpty ? String(localized: "Idle") : status
        }
    }

    static func isTerminal(_ status: String) -> Bool {
        ["completed", "failed", "approval_rejected", "canceled", "cancelled", "skipped", "timed_out"].contains(status)
    }
}

/// Human description of a cron expression for the schedules list (only
/// the common shapes; anything else is shown verbatim).
enum CronDescription {
    static func describe(_ expression: String) -> String {
        let parts = expression.split(separator: " ").map(String.init)
        guard parts.count == 5 else { return expression }
        let minute = parts[0], hour = parts[1], day = parts[2], month = parts[3], weekday = parts[4]
        guard let minuteValue = Int(minute), let hourValue = Int(hour), day == "*" || day == "?" , month == "*" else {
            if minute.hasPrefix("*/"), let every = Int(minute.dropFirst(2)), hour == "*" { return String(localized: "Every \(every) minutes") }
            if minute == "0", hour.hasPrefix("*/"), let every = Int(hour.dropFirst(2)) { return String(localized: "Every \(every) hours") }
            return expression
        }
        let time = String(format: "%02d:%02d", hourValue, minuteValue)
        if weekday == "*" { return String(localized: "Daily at \(time)") }
        if weekday == "1-5" { return String(localized: "Weekdays at \(time)") }
        return String(localized: "At \(time) on days \(weekday)")
    }
}
