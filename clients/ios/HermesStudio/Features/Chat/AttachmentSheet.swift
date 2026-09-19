import SwiftUI

/// One attachment action: the Core Hub line icon, the label, a one-line
/// caption saying what the row actually opens, and the picker it launches.
struct AttachmentAction: Identifiable {
    let id: String
    let icon: CoreHubIcon
    let label: LocalizedStringKey
    let caption: LocalizedStringKey
    let run: () -> Void
}

/// A titled block of actions inside the sheet.
struct AttachmentGroup: Identifiable {
    let id: String
    let title: LocalizedStringKey
    let actions: [AttachmentAction]
}

enum AttachmentMenu {
    /// What the "+" offers, in the web client's order.
    ///
    /// The web composer has one "Attach files" control (`ChatInput.vue`, the
    /// same 24-viewBox plus icon); on a phone that one control splits into the
    /// camera, the photo library and the file picker. The wording is the web's,
    /// and the two mobile clients carry the same rows in the same order.
    static func groups(
        onCamera: @escaping () -> Void,
        onPhotos: @escaping () -> Void,
        onFiles: @escaping () -> Void
    ) -> [AttachmentGroup] {
        [
            AttachmentGroup(id: "photos", title: "Photos", actions: [
                AttachmentAction(id: "camera", icon: .camera, label: "Take photo", caption: "Open the camera now", run: onCamera),
                AttachmentAction(id: "library", icon: .image, label: "Photo library", caption: "Choose from your photos", run: onPhotos),
            ]),
            AttachmentGroup(id: "documents", title: "Documents", actions: [
                AttachmentAction(id: "files", icon: .paperclip, label: "Files", caption: "Any file from this device", run: onFiles),
            ]),
        ]
    }
}

/// The composer's "+" and the sheet it opens.
///
/// The picker runs from the sheet's `onDismiss`, so the camera or the document
/// picker is never presented on top of a sheet that is still sliding away.
struct AttachmentSheetButton: View {
    let onCamera: () -> Void
    let onPhotos: () -> Void
    let onFiles: () -> Void

    @State private var presented = false
    @State private var pending: (() -> Void)?
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        Button { presented = true } label: { plus }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Attach"))
            .sheet(isPresented: $presented, onDismiss: runPending) {
                AttachmentSheet(
                    groups: AttachmentMenu.groups(onCamera: onCamera, onPhotos: onPhotos, onFiles: onFiles),
                    choose: { action in pending = action.run; presented = false },
                    close: { presented = false }
                )
                .environment(\.layoutDirection, layoutDirection)
            }
    }

    private var plus: some View {
        CoreHubIconView(icon: .plus, size: 18)
            .foregroundStyle(CoreHubTokens.Palette.textSecondary)
            .frame(width: CoreHubTokens.Layout.composerButton, height: CoreHubTokens.Layout.composerButton)
            .background(CoreHubTokens.Palette.bgCard, in: Circle())
            .overlay(Circle().stroke(CoreHubTokens.Palette.inputBorderIdle))
    }

    private func runPending() {
        let action = pending
        pending = nil
        action?()
    }
}

/// A bottom sheet with a drag handle, a title block, grouped full-width rows
/// (icon tile, label, caption, chevron) and a Close button — instead of the
/// cramped menu that used to hang off the "+". Everything is written in
/// leading/trailing terms, so Arabic mirrors the rows and the chevron.
struct AttachmentSheet: View {
    let groups: [AttachmentGroup]
    let choose: (AttachmentAction) -> Void
    let close: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            AttachmentSheetHandle()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    AttachmentSheetHeader()
                    ForEach(groups) { group in
                        if group.id != groups.first?.id {
                            Divider()
                                .overlay(CoreHubTokens.Palette.borderLight)
                                .padding(.horizontal, CoreHubTokens.Layout.sheetPadding)
                                .padding(.vertical, 6)
                        }
                        AttachmentGroupHeader(title: group.title)
                        ForEach(group.actions) { action in
                            AttachmentRowView(action: action) { choose(action) }
                        }
                    }
                }
            }
            AttachmentSheetCloseButton(action: close)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .presentationDetents([.height(estimatedHeight), .large])
        .presentationDragIndicator(.hidden)
        .presentationCornerRadius(CoreHubTokens.Radius.composer)
        .presentationBackground(CoreHubTokens.Palette.bgCard)
    }

    /// Detent estimate from the layout tokens; a larger text size only makes
    /// the sheet taller, and `.large` stays available for anything beyond it.
    private var estimatedHeight: CGFloat {
        let rows = CGFloat(groups.reduce(0) { $0 + $1.actions.count })
        let headers = CGFloat(groups.count)
        let content = CoreHubTokens.Layout.sheetHeaderHeight
            + headers * CoreHubTokens.Layout.sheetGroupHeaderHeight
            + rows * (CoreHubTokens.Layout.sheetRowMinHeight + 8)
        let scale = max(1, CoreHubTokens.Typography.scale)
        return CoreHubTokens.Layout.sheetHandleArea + content * scale + CoreHubTokens.Layout.sheetFooterHeight
    }
}

/// The 36 × 4 handle, accent at the idle input-border strength.
private struct AttachmentSheetHandle: View {
    var body: some View {
        Capsule()
            .fill(CoreHubTokens.Palette.inputBorderIdle)
            .frame(width: CoreHubTokens.Layout.sheetHandleWidth, height: CoreHubTokens.Layout.sheetHandleHeight)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
            .accessibilityHidden(true)
    }
}

/// Title 16/600 and a muted line saying what the sheet is for.
private struct AttachmentSheetHeader: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Attach files")
                .font(CoreHubTokens.Typography.titleFont)
                .foregroundStyle(CoreHubTokens.Palette.textPrimary)
            Text("Choose what to add to this message")
                .font(CoreHubTokens.Typography.metaFont)
                .foregroundStyle(CoreHubTokens.Palette.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, CoreHubTokens.Layout.sheetPadding)
        .padding(.bottom, 4)
    }
}

/// Group label: 10/600 uppercase with the spec's letter-spacing.
private struct AttachmentGroupHeader: View {
    let title: LocalizedStringKey

    var body: some View {
        Text(title)
            .font(CoreHubTokens.Typography.groupHeaderFont)
            .tracking(CoreHubTokens.Typography.groupHeaderTracking)
            .textCase(.uppercase)
            .foregroundStyle(CoreHubTokens.Palette.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, CoreHubTokens.Layout.sheetPadding)
            .padding(.top, 14)
            .padding(.bottom, 6)
    }
}

/// One action row: icon tile, label over caption, trailing chevron.
private struct AttachmentRowView: View {
    let action: AttachmentAction
    let tap: () -> Void

    var body: some View {
        Button(action: tap) { row }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(action.label))
            .accessibilityHint(Text(action.caption))
    }

    private var row: some View {
        HStack(spacing: CoreHubTokens.Layout.sheetRowGap) {
            tile
            VStack(alignment: .leading, spacing: 2) {
                Text(action.label)
                    .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.navItem, weight: CoreHubTokens.Typography.titleWeight))
                    .foregroundStyle(CoreHubTokens.Palette.textPrimary)
                Text(action.caption)
                    .font(CoreHubTokens.Typography.metaFont)
                    .foregroundStyle(CoreHubTokens.Palette.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            CoreHubIconView(icon: .chevronForward, size: CoreHubTokens.Layout.sheetTrailingIcon)
                .foregroundStyle(CoreHubTokens.Palette.textMuted)
        }
        .padding(.horizontal, CoreHubTokens.Layout.sheetPadding)
        .padding(.vertical, 8)
        .frame(minHeight: CoreHubTokens.Layout.sheetRowMinHeight)
        .contentShape(Rectangle())
    }

    private var tile: some View {
        CoreHubIconView(icon: action.icon, size: CoreHubTokens.Layout.sheetIcon)
            .foregroundStyle(CoreHubTokens.Palette.textPrimary)
            .frame(width: CoreHubTokens.Layout.sheetIconTile, height: CoreHubTokens.Layout.sheetIconTile)
            .background(CoreHubTokens.Palette.hover, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.bubble, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: CoreHubTokens.Radius.bubble, style: .continuous)
                    .stroke(CoreHubTokens.Palette.borderLight)
            )
    }
}

/// The explicit way out, next to the handle and the pull-down gesture.
private struct AttachmentSheetCloseButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text("Close")
                .font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.navItem, weight: CoreHubTokens.Typography.titleWeight))
                .foregroundStyle(CoreHubTokens.Palette.textSecondary)
                .frame(maxWidth: .infinity, minHeight: CoreHubTokens.Layout.sheetButtonHeight)
                .overlay(
                    RoundedRectangle(cornerRadius: CoreHubTokens.Radius.button, style: .continuous)
                        .stroke(CoreHubTokens.Palette.border)
                )
        }
        .buttonStyle(.plain)
        .padding(.horizontal, CoreHubTokens.Layout.sheetPadding)
        .padding(.top, 14)
        .padding(.bottom, CoreHubTokens.Layout.sheetPadding)
    }
}
