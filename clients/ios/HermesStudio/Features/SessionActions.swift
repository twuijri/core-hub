import SwiftUI

/// Session actions shared by the drawer list, History and the chat header
/// (web `session-menu-options.ts`): rename, pin, category, archive, export,
/// delete and the batch operations. Every call reports failures through the
/// store banner and bumps `sessionListVersion` so lists reload.
@MainActor
struct SessionActions {
    let store: AppStore

    func rename(_ session: SessionSummary, to title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard await store.attempt({ try await store.api.renameSession(session.id, title: trimmed) }) != nil else { return }
        if store.selectedSession?.id == session.id { store.selectedSession?.title = trimmed }
        store.sessionsChanged()
    }

    func archive(_ session: SessionSummary, archived: Bool = true) async {
        guard await store.attempt({ try await store.api.setSessionArchived(session.id, archived: archived) }) != nil else { return }
        if archived, store.selectedSession?.id == session.id { store.selectedSession = nil }
        store.notify(archived ? String(localized: "Conversation archived") : String(localized: "Conversation restored"))
        store.sessionsChanged()
    }

    func delete(_ session: SessionSummary) async {
        guard await store.attempt({ try await store.api.deleteSession(session.id) }) != nil else { return }
        store.browserPrefs.unpin(session.id, profile: session.profile)
        if store.selectedSession?.id == session.id { store.selectedSession = nil }
        store.sessionsChanged()
    }

    func assign(_ session: SessionSummary, category: Int?) async {
        guard await store.attempt({ try await store.api.setSessionCategory(session.id, categoryID: category) }) != nil else { return }
        store.sessionsChanged()
    }

    /// Exports the session (`full` JSON or `compressed` text) to a temporary
    /// file for the share sheet.
    func export(_ session: SessionSummary, mode: String, ext: String) async -> URL? {
        await store.attempt {
            let data = try await store.api.exportSession(session.id, mode: mode, ext: ext)
            let name = "session-\(session.id.prefix(8)).\(ext)"
            return try APIClient.writeTemporaryFile(data, name: name)
        }
    }

    // MARK: Batch

    func batchArchive(_ sessions: [SessionSummary], archived: Bool) async {
        guard !sessions.isEmpty else { return }
        guard let result = await store.attempt({ try await store.api.batchArchiveSessions(sessions.map(\.id), archived: archived) }) else { return }
        report(result, verb: archived ? String(localized: "archived") : String(localized: "restored"))
        if archived, let current = store.selectedSession, sessions.contains(where: { $0.id == current.id }) { store.selectedSession = nil }
        store.sessionsChanged()
    }

    func batchDelete(_ sessions: [SessionSummary]) async {
        guard !sessions.isEmpty else { return }
        guard let result = await store.attempt({ try await store.api.batchDeleteSessionsResult(sessions) }) else { return }
        for session in sessions { store.browserPrefs.unpin(session.id, profile: session.profile) }
        report(result, verb: String(localized: "deleted"))
        if let current = store.selectedSession, sessions.contains(where: { $0.id == current.id }) { store.selectedSession = nil }
        store.sessionsChanged()
    }

    func batchAssign(_ sessions: [SessionSummary], category: Int?) async {
        var failed = 0
        for session in sessions {
            do { try await store.api.setSessionCategory(session.id, categoryID: category) } catch { failed += 1 }
        }
        if failed > 0 { store.errorMessage = String(localized: "\(failed) conversations could not be moved") }
        else { store.notify(String(localized: "\(sessions.count) conversations moved")) }
        store.sessionsChanged()
    }

    private func report(_ result: BatchResult, verb: String) {
        if result.failed > 0 {
            store.errorMessage = String(localized: "\(result.succeeded) \(verb), \(result.failed) failed") + (result.errors.first.map { " — \($0)" } ?? "")
        } else {
            store.notify(String(localized: "\(result.succeeded) conversations \(verb)"))
        }
    }
}

/// Bottom bar of the batch selection mode: count, archive / unarchive,
/// move to category, delete, and cancel.
struct SessionBatchBar: View {
    let selectedCount: Int
    let archiveCount: Int
    let unarchiveCount: Int
    let categories: [SessionCategory]
    let onArchive: () -> Void
    let onUnarchive: () -> Void
    let onMove: (Int?) -> Void
    let onDelete: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Text("\(selectedCount) selected")
                .font(CoreHubTokens.Typography.metaFont)
                .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                .lineLimit(1)
            Spacer(minLength: 4)
            if archiveCount > 0 {
                BatchButton(symbol: "archivebox", label: String(localized: "Archive"), action: onArchive)
            }
            if unarchiveCount > 0 {
                BatchButton(symbol: "tray.and.arrow.up", label: String(localized: "Unarchive"), action: onUnarchive)
            }
            Menu {
                Button(String(localized: "No category")) { onMove(nil) }
                ForEach(categories) { category in Button(category.name) { onMove(category.id) } }
            } label: {
                BatchButtonLabel(symbol: "folder", label: String(localized: "Move"))
            }
            .disabled(selectedCount == 0)
            BatchButton(symbol: "trash", label: String(localized: "Delete"), destructive: true, action: onDelete).disabled(selectedCount == 0)
            Button(action: onCancel) {
                CoreHubIconView(icon: .close, size: 16).foregroundStyle(CoreHubTokens.Palette.textSecondary).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel selection")
        }
        .padding(.horizontal, 10)
        .frame(height: 44)
        .background(CoreHubTokens.Palette.bgCard)
        .overlay(alignment: .top) { Rectangle().fill(CoreHubTokens.Palette.borderLight).frame(height: 1) }
    }
}

private struct BatchButton: View {
    let symbol: String
    let label: String
    var destructive = false
    let action: () -> Void

    var body: some View {
        Button(action: action) { BatchButtonLabel(symbol: symbol, label: label, destructive: destructive) }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
    }
}

private struct BatchButtonLabel: View {
    let symbol: String
    let label: String
    var destructive = false

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(destructive ? CoreHubTokens.Palette.error : CoreHubTokens.Palette.textPrimary)
            .frame(width: 32, height: 30)
            .background(CoreHubTokens.Palette.hover, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.button, style: .continuous))
            .contentShape(Rectangle())
    }
}

/// Selection circle shown at the start of a row in batch mode.
struct BatchSelectionMark: View {
    let selected: Bool

    var body: some View {
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 18, weight: .regular))
            .foregroundStyle(selected ? CoreHubTokens.Palette.accent : CoreHubTokens.Palette.textMuted)
            .frame(width: 26, height: 26)
            .accessibilityLabel(selected ? Text("Selected") : Text("Not selected"))
    }
}

/// The long-press / ⋯ menu of a session row (web `buildSessionContextMenu`):
/// rename, pin, move to category, archive/unarchive, export, session
/// settings, delete.
struct SessionContextMenu: View {
    let session: SessionSummary
    let pinned: Bool
    let categories: [SessionCategory]
    let onRename: () -> Void
    let onPin: () -> Void
    let onAssign: (Int?) -> Void
    let onArchive: () -> Void
    let onExport: (String, String) -> Void
    let onSettings: () -> Void
    let onDelete: () -> Void

    var body: some View {
        Button(action: onRename) { Label("Rename", systemImage: "pencil") }
        Button(action: onPin) { Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin") }
        Menu {
            Button("No category") { onAssign(nil) }
            ForEach(categories) { category in
                Button { onAssign(category.id) } label: {
                    if session.categoryID == category.id { Label(category.name, systemImage: "checkmark") } else { Text(category.name) }
                }
            }
        } label: { Label("Move to category", systemImage: "folder") }
        if session.source != "global_agent" {
            Button(action: onArchive) { Label(session.archived ? "Unarchive" : "Archive", systemImage: session.archived ? "tray.and.arrow.up" : "archivebox") }
        }
        Menu {
            Button("Full JSON") { onExport("full", "json") }
            Button("Compressed text") { onExport("compressed", "txt") }
        } label: { Label("Export", systemImage: "square.and.arrow.up") }
        Button(action: onSettings) { Label("Session settings", systemImage: "slider.horizontal.3") }
        Button(role: .destructive, action: onDelete) { Label("Delete", systemImage: "trash") }
    }
}

/// Share sheet for an exported session file.
struct ExportShareSheet: View {
    let url: URL
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Image(systemName: "doc.text").font(.system(size: 40)).foregroundStyle(CoreHubTokens.Palette.accent)
                TechnicalText(text: url.lastPathComponent, font: CoreHubTokens.Typography.font(CoreHubTokens.Typography.sidebarTab), color: CoreHubTokens.Palette.textPrimary)
                ShareLink(item: url) { Label("Share export", systemImage: "square.and.arrow.up") }
                    .buttonStyle(CoreHubPillButtonStyle(prominent: true))
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(CoreHubTokens.Palette.bgPrimary)
            .navigationTitle("Export")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

extension URL: Identifiable {
    public var id: String { absoluteString }
}
