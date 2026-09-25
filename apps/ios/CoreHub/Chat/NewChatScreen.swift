// A new chat is a draft (destination `new_chat`): the agent chips above the composer, and the
// session is made on the first message, in the selector's profile, which the screen names.
import CoreHubClient
import SwiftUI

struct NewChatScreen: View {
    /// Opens the conversation the first message made.
    let opened: (_ sessionID: String, _ profile: String, _ firstMessage: String) -> Void
    /// Text shared from another app, put in the composer to review before sending.
    var seed: String? = nil
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var draft = ""
    @State private var agentID: String?
    @State private var creating = false
    @State private var error: String?

    private var usable: [Agent] {
        app.agents.filter { $0.enabled && ($0.status == .available || $0.status == .limited) }
    }

    private var chosen: Agent? {
        usable.first { $0.id == agentID } ?? usable.first
    }

    var body: some View {
        VStack(spacing: Space.s3) {
            // The empty part of the screen above the composer: a tap there puts the keyboard away.
            VStack(spacing: Space.s3) {
                Spacer()
                BrandMark(size: 48)
                Text(l10n("chat.new_in_profile", ["profile": app.profileName(app.currentProfile)]))
                    .font(.system(size: FontSize.sizeXl, weight: .semibold))
                    .foregroundStyle(Tone.text)
                    .multilineTextAlignment(.center)
                Text(l10n("chat.start_hint"))
                    .font(.system(size: FontSize.sizeSm))
                    .foregroundStyle(Tone.textMuted)
                    .multilineTextAlignment(.center)
                Spacer()
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .dismissesKeyboardOnTap()
            if usable.isEmpty {
                NoticeView(text: l10n("chat.no_agent"), tone: .warning)
            } else {
                agentChips
            }
            if let error {
                NoticeView(text: error, tone: .danger)
            }
            Composer(
                text: $draft,
                placeholder: l10n("chat.placeholder", ["agent": chosen?.name ?? l10n("chat.agent")]),
                busy: false,
                sending: creating || chosen == nil,
                onSend: start,
                onStop: {}
            )
        }
        .padding(.horizontal, Space.s3)
        .padding(.bottom, Space.s2)
        .background(Tone.bg)
.onAppear { if let seed, draft.isEmpty { draft = seed } }
        .navigationTitle(l10n("nav.new_chat"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("screen.new_chat")
    }

    private var agentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.s2) {
                ForEach(usable, id: \.id) { agent in
                    let selected = agent.id == chosen?.id
                    Button {
                        agentID = agent.id
                    } label: {
                        Text(agent.name)
                            .font(.system(size: FontSize.sizeSm, weight: selected ? .semibold : .regular))
                            .padding(.horizontal, Space.s3)
                            .frame(height: Control.heightMd)
                            .foregroundStyle(selected ? Tone.accentSoftText : Tone.text)
                            .background(selected ? Tone.accentSoft : Tone.surface, in: Capsule())
                            .overlay(Capsule().strokeBorder(selected ? Tone.accent : Tone.border))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
    }

    private func start() {
        guard let agent = chosen else { return }
        let text = draft
        let profile = app.currentProfile
        let key = ULID.make()
        creating = true
        error = nil
        Task {
            defer { creating = false }
            do {
                let session = try await app.api.call {
                    try await SessionsAPI.sessionsCreate(
                        xHubProfile: profile,
                        sessionCreate: SessionCreate(agentId: agent.id),
                        idempotencyKey: key,
                        apiConfiguration: $0
                    )
                }
                draft = ""
                opened(session.id, session.profile, text)
            } catch {
                self.error = HubFailure(error).describe(l10n)
            }
        }
    }
}
