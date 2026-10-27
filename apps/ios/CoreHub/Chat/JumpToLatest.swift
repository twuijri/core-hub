// "Jump to latest" (owner, 2026-10-27): a small round ↓ floating above the composer while the
// reader has scrolled up from the newest message, in a hub chat and in a Telegram or WhatsApp
// conversation alike — the web's `JumpToLatest.tsx`. One tap brings the newest message back;
// at the bottom it is not there at all.
import SwiftUI

struct JumpToLatestButton: View {
    let jump: () -> Void
    @Environment(\.l10n) private var l10n

    var body: some View {
        Button(action: jump) {
            LucideIcon(.arrowDown, size: 18)
                .foregroundStyle(Tone.text)
                .frame(width: 40, height: 40)
                .background(.ultraThinMaterial, in: Circle())
                .overlay(Circle().stroke(Tone.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(l10n("chat.jump_latest"))
        .accessibilityIdentifier("chat.jump_latest")
        .padding(.bottom, Space.s2)
        .transition(.opacity)
    }
}
