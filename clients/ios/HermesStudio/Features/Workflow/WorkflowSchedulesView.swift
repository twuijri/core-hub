import SwiftUI

/// Cron schedules of a workflow with an enable/disable switch per row
/// (`PATCH …/schedules/{id} { enabled }`), plus create, edit and delete.
struct WorkflowSchedulesView: View {
    @EnvironmentObject private var store: AppStore
    let workflow: WorkflowItem

    @State private var schedules: [WorkflowSchedule] = []
    @State private var loading = true
    @State private var editing: WorkflowSchedule?
    @State private var creating = false

    var body: some View {
        List {
            if loading && schedules.isEmpty { ProgressView() }
            if !loading && schedules.isEmpty {
                Text("No schedules yet").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted)
            }
            ForEach(schedules) { schedule in row(schedule) }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Schedules")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { creating = true } label: { CoreHubIconView(icon: .plus, size: 20) }.accessibilityLabel("New schedule") } }
        .refreshable { await load() }
        .task { await load() }
        .sheet(isPresented: $creating) { WorkflowScheduleEditor(workflowID: workflow.id, schedule: nil) { await load() } }
        .sheet(item: $editing) { item in WorkflowScheduleEditor(workflowID: workflow.id, schedule: item) { await load() } }
    }

    private func row(_ schedule: WorkflowSchedule) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(CronDescription.describe(schedule.schedule)).font(CoreHubTokens.Typography.sessionTitleFont)
                    TechnicalText(text: "\(schedule.schedule) · \(schedule.timezone)")
                }
                Spacer(minLength: 0)
                Toggle("", isOn: Binding(get: { schedule.enabled }, set: { value in Task { await setEnabled(schedule, value) } }))
                    .labelsHidden()
                    .accessibilityLabel("Enabled")
            }
            if let next = schedule.nextRun, next > 0 {
                Text("Next run \(SessionTimeFormatter.string(for: Date(timeIntervalSince1970: Double(next) / 1000), locale: store.locale))")
                    .font(CoreHubTokens.Typography.metaFont)
                    .foregroundStyle(CoreHubTokens.Palette.textMuted)
            }
            if !schedule.error.isEmpty {
                Text(schedule.error).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.error)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { editing = schedule }
        .swipeActions {
            Button(role: .destructive) { Task { await delete(schedule) } } label: { Label("Delete", systemImage: "trash") }
        }
    }

    private func load() async {
        loading = true
        schedules = (await store.attempt { try await store.api.workflowSchedules(workflow.id) }) ?? schedules
        loading = false
    }

    private func setEnabled(_ schedule: WorkflowSchedule, _ enabled: Bool) async {
        guard await store.attempt({ try await store.api.setWorkflowScheduleEnabled(workflowID: workflow.id, scheduleID: schedule.id, enabled: enabled) }) != nil else { return }
        if let index = schedules.firstIndex(where: { $0.id == schedule.id }) { schedules[index].enabled = enabled }
    }

    private func delete(_ schedule: WorkflowSchedule) async {
        guard await store.attempt({ try await store.api.deleteWorkflowSchedule(workflowID: workflow.id, scheduleID: schedule.id) }) != nil else { return }
        schedules.removeAll { $0.id == schedule.id }
    }
}

struct WorkflowScheduleEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let workflowID: String
    let schedule: WorkflowSchedule?
    let reload: () async -> Void

    @State private var expression = "0 9 * * *"
    @State private var timezone = TimeZone.current.identifier
    @State private var enabled = true
    @State private var input = ""
    @State private var state: SaveState = .idle

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Cron expression", text: $expression).textInputAutocapitalization(.never).autocorrectionDisabled().environment(\.layoutDirection, .leftToRight)
                    Text(CronDescription.describe(expression)).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted)
                    TextField("Time zone", text: $timezone).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Toggle("Enabled", isOn: $enabled)
                } header: { Text("Schedule") } footer: { Text("Five cron fields: minute, hour, day of month, month, day of week.") }
                Section("Input") {
                    TextField("Optional input", text: $input, axis: .vertical).lineLimit(1...5)
                }
                Section { SaveStateLabel(state: state) }
            }
            .navigationTitle(schedule == nil ? "New schedule" : "Edit schedule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(expression.isEmpty || timezone.isEmpty || state.isSaving)
                }
            }
            .onAppear {
                guard let schedule else { return }
                expression = schedule.schedule
                timezone = schedule.timezone
                enabled = schedule.enabled
                input = schedule.input
            }
        }
    }

    private func save() async {
        state = .saving
        do {
            try await store.api.saveWorkflowSchedule(workflowID: workflowID, scheduleID: schedule?.id, schedule: expression, timezone: timezone, enabled: enabled, input: input)
            state = .saved
            await reload()
            dismiss()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
