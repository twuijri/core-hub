// Tasks and Schedules show every profile the person may enter, with no profile filter
// (profileScope.alwaysAll, ADR 0016): each item carries its profile's badge, and anything done to
// it goes to its own profile without moving the selector.
import CoreHubClient
import SwiftUI

enum TaskColumns {
    /// The board's columns in the hub's order; `archived` stays off the phone's board.
    static let order: [TaskStatus] = [.triage, .todo, .ready, .scheduled, .running, .blocked, .review, .done]
}

struct TasksScreen: View {
    let openChat: (_ sessionID: String, _ profile: String) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: "tasks") {
            let header = app.currentProfile
            return try await app.api.call {
                try await TasksAPI.tasksListTasks(xHubProfile: header, profiles: .all, limit: 200, apiConfiguration: $0)
            }.items
        } content: { tasks, reload in
            List {
                if tasks.isEmpty { Text(l10n("tasks.empty")).foregroundStyle(Tone.textMuted) }
                ForEach(TaskColumns.order, id: \.self) { status in
                    let column = tasks.filter { $0.status == status }
                    if !column.isEmpty {
                        Section(l10n("tasks.status_\(status.rawValue)") + " · \(column.count)") {
                            ForEach(column, id: \.id) { task in
                                TaskRow(task: task, openChat: openChat, changed: reload)
                            }
                        }
                    }
                }
            }
            .refreshable { reload() }
        }
        .navigationTitle(l10n("nav.tasks"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("screen.tasks")
    }
}

struct TaskRow: View {
    let task: HubTask
    let openChat: (_ sessionID: String, _ profile: String) -> Void
    let changed: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            HStack(alignment: .firstTextBaseline) {
                Text(task.title)
                    .font(.system(size: FontSize.sizeMd, weight: .medium))
                    .contentDirection(of: task.title)
                if app.enterableProfiles.count > 1 { ProfileBadge(name: app.profileName(task.profile)) }
            }
            HStack(spacing: Space.s2) {
                StatusPill(text: l10n("tasks.priority_\(task.priority.rawValue)"), kind: task.priority == .urgent || task.priority == .high ? .warn : .neutral)
                if let assignee = task.assignee {
                    Text(assignee.name).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                }
            }
            if let reason = task.blockedReason ?? task.statusReason {
                Text(reason).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted).lineLimit(2)
            }
            if let summary = task.latestSummary {
                Text(summary).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted).lineLimit(3)
                    .contentDirection(of: summary)
            }
            if let error { NoticeView(text: error, tone: .danger) }
        }
        .contextMenu {
            if let sessionID = task.sessionId {
                Button(l10n("tasks.open_chat")) { openChat(sessionID, task.profile) }
            }
            Menu(l10n("tasks.move")) {
                ForEach(TaskColumns.order.filter { $0 != task.status }, id: \.self) { status in
                    Button(l10n("tasks.status_\(status.rawValue)")) { Task { await move(to: status) } }
                }
            }
        }
        .swipeActions {
            if let sessionID = task.sessionId {
                Button(l10n("tasks.open_chat")) { openChat(sessionID, task.profile) }.tint(Tone.accent)
            }
        }
    }

    private func move(to status: TaskStatus) async {
        // An existing task is acted on in its own profile.
        let profile = task.profile
        do {
            _ = try await app.api.call {
                try await TasksAPI.tasksMoveTask(xHubProfile: profile, taskId: task.id, taskMove: TaskMove(status: status), apiConfiguration: $0)
            }
            error = nil
            changed()
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }
}

struct SchedulesScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n

    var body: some View {
        AsyncContent(key: "schedules") {
            try await app.api.call { try await SchedulesAPI.schedulesList(profiles: .all, limit: 200, apiConfiguration: $0) }.items
        } content: { schedules, reload in
            List {
                if schedules.isEmpty { Text(l10n("schedules.empty")).foregroundStyle(Tone.textMuted) }
                ForEach(schedules, id: \.id) { schedule in
                    ScheduleRow(schedule: schedule, showProfile: app.enterableProfiles.count > 1, changed: reload)
                }
            }
            .refreshable { reload() }
        }
        .navigationTitle(l10n("nav.schedules"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("screen.schedules")
    }
}

struct ScheduleRow: View {
    let schedule: Schedule
    let showProfile: Bool
    let changed: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var note: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            HStack(alignment: .firstTextBaseline) {
                Text(schedule.name).font(.system(size: FontSize.sizeMd, weight: .medium))
                    .contentDirection(of: schedule.name)
                if showProfile { ProfileBadge(name: app.profileName(schedule.profile)) }
            }
            HStack(spacing: Space.s2) {
                StatusPill(text: l10n("schedules.state_\(schedule.state.rawValue)"), kind: schedule.state == .running ? .good : schedule.state == .paused ? .warn : .neutral)
                if let display = schedule.trigger.display {
                    Text(display).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
                }
            }
            if let next = schedule.nextRunAt {
                Text(l10n("schedules.next", ["time": next.shortText(app.language)]))
                    .font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.textMuted)
            }
            if let lastError = schedule.lastError {
                Text(lastError).font(.system(size: FontSize.sizeXs)).foregroundStyle(Tone.danger).lineLimit(2)
            }
            if let note { NoticeView(text: note, tone: .info) }
            Button {
                Task { await runNow() }
            } label: {
                Label(l10n("schedules.run_now"), systemImage: "play")
            }
            .font(.system(size: FontSize.sizeSm))
            .disabled(busy)
        }
    }

    private func runNow() async {
        busy = true
        defer { busy = false }
        let profile = schedule.profile
        do {
            _ = try await app.api.call {
                try await SchedulesAPI.schedulesRunNow(xHubProfile: profile, scheduleId: schedule.id, apiConfiguration: $0)
            }
            note = l10n("schedules.started")
            changed()
        } catch {
            note = HubFailure(error).describe(l10n)
        }
    }
}
