// One room (destination `rooms`): the transcript — your messages on the right, everyone else,
// people and agents, on the left under their names — each seat's reply streaming in, what the
// seats are doing now, what they wait for you to answer, and the chat's own composer (mic,
// files, and `@` offering the room's seats). The members sheet opens from the toolbar.
import CoreHubClient
import SwiftUI
import UIKit

struct RoomScreen: View {
    @State var model: RoomModel
    /// Leaves the room's page (left, removed, deleted).
    let onGone: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var draft = ""
    @State private var tray: AttachmentTray?
    @State private var showingMembers = false

    var body: some View {
        VStack(spacing: 0) {
            switch model.load {
            case .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                VStack(spacing: Space.s3) {
                    NoticeView(text: message, tone: .danger)
                    Button(l10n("common.retry")) { Task { await model.fetch() } }
                }
                .padding(Space.s4)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .ready:
                transcript
            }
            bottom
        }
        .background(Tone.bg)
        .navigationTitle(model.state.name.isEmpty ? l10n("rooms.untitled") : model.state.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingMembers = true } label: { Image(systemName: "person.2") }
                    .accessibilityLabel(l10n("rooms.members_title"))
                    .accessibilityIdentifier("room.members")
            }
        }
        .sheet(isPresented: $showingMembers) {
            NavigationStack { RoomMembersSheet(model: model) }
        }
        .onAppear {
            if tray == nil { tray = AttachmentTray(app: app) }
            model.start()
        }
        .onDisappear { model.stop() }
        .onChange(of: model.gone) { _, gone in if gone { onGone() } }
        .onChange(of: draft) { _, text in if !text.isEmpty { model.typing(true) } }
        .accessibilityIdentifier("screen.room")
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if model.state.hasOlder {
                        Button {
                            Task { await model.loadOlder() }
                        } label: {
                            if model.loadingOlder { ProgressView() } else { Text(l10n("sessions.load_more")) }
                        }
                        .font(.system(size: FontSize.sizeSm))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Space.s2)
                    }
                    let visible = model.state.messages.filter { !$0.isEmpty }
                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, message in
                        MessageRow(
                            message: message,
                            startsTurn: RoomTurns.startsTurn(visible, at: index, me: model.me),
                            run: nil,
                            profile: model.profile,
                            mine: RoomTurns.isMine(message, me: model.me)
                        )
                        .id(message.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, Space.s4)
                .padding(.vertical, Space.s3)
            }
            .scrollDismissesKeyboard(.interactively)
            .dismissesKeyboardOnTap()
            .defaultScrollAnchor(.bottom)
            .onChange(of: model.state.messages.last?.text.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: model.state.messages.count) { _, _ in
                withAnimation(.easeOut(duration: Motion.fast)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    private var bottom: some View {
        VStack(spacing: Space.s2) {
            if model.state.archived {
                NoticeView(text: l10n("rooms.archived"), tone: .info)
            }
            ForEach(model.state.pendingApprovals, id: \.id) { approval in
                ApprovalCard(approval: approval) { decision, answer in
                    Task { await model.respond(approval, decision: decision, answer: answer) }
                }
            }
            ForEach(model.state.busySeats, id: \.id) { seat in
                SeatActivity(seat: seat, step: model.state.step(of: seat)) {
                    Task { await model.stopSeat(seat) }
                }
            }
            let typing = typingNames
            if !typing.isEmpty {
                Text(l10n("rooms.typing", ["names": typing.joined(separator: "، ")]))
                    .font(.system(size: FontSize.sizeXs))
                    .foregroundStyle(Tone.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let error = model.actionError {
                NoticeView(text: error, tone: .danger)
                    .onTapGesture { model.actionError = nil }
            }
            mentionChips
            if !model.state.archived {
                Composer(
                    text: $draft,
                    placeholder: l10n("rooms.placeholder"),
                    busy: false,
                    sending: model.sending,
                    onSend: {
                        let message = tray?.message(draft) ?? OutgoingMessage(text: draft)
                        let words = draft
                        draft = ""
                        tray?.clear()
                        Task {
                            let sent = await model.send(message)
                            if !sent, draft.isEmpty { draft = words }
                        }
                    },
                    onStop: {},
                    attachments: tray,
                    profile: model.profile,
                    recentText: model.state.messages.suffix(8).map(\.text)
                )
            }
        }
        .padding(.horizontal, Space.s3)
        .padding(.bottom, Space.s2)
    }

    /// Everyone typing but you.
    private var typingNames: [String] {
        let mine = Set(model.state.members.filter { $0.userId == model.me }.map(\.id))
        return model.state.typing.filter { !mine.contains($0.key) }.map(\.value).sorted()
    }

    /// `@` offers the room's seats, and «everyone» where the room allows it.
    @ViewBuilder
    private var mentionChips: some View {
        if let query = RoomMentions.query(draft) {
            let seats = RoomMentions.suggest(model.state.mentionSeats, query.query)
            let all = model.state.canMentionAll && "all".hasPrefix(query.query.lowercased())
            if !seats.isEmpty || all {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Space.s2) {
                        if all { chip(l10n("rooms.mention_all"), name: "all", start: query.start) }
                        ForEach(seats) { seat in chip("@\(seat.name)", name: seat.name, start: query.start) }
                    }
                }
                .accessibilityIdentifier("room.mentions")
            }
        }
    }

    private func chip(_ label: String, name: String, start: Int) -> some View {
        Button {
            draft = RoomMentions.insert(draft, start: start, name: name)
        } label: {
            Text(label)
                .font(.system(size: FontSize.sizeSm, weight: .medium))
                .padding(.horizontal, Space.s3)
                .frame(height: Control.heightSm)
                .background(Tone.surface2, in: Capsule())
                .contentDirection(of: label)
        }
        .buttonStyle(.plain)
    }
}

/// A seat at work: who, what it is doing, the tool it is in, and Stop.
struct SeatActivity: View {
    let seat: Seat
    let step: String?
    let stop: () -> Void
    @Environment(\.l10n) private var l10n

    var body: some View {
        HStack(spacing: Space.s2) {
            Circle().fill(Tone.statusRunning).frame(width: 8, height: 8)
            Text(line)
                .font(.system(size: FontSize.sizeSm))
                .foregroundStyle(Tone.textMuted)
                .lineLimit(1)
            Spacer(minLength: 0)
            Button(action: stop) {
                Image(systemName: "stop.circle")
                    .foregroundStyle(Tone.danger)
                    .frame(width: Control.heightSm, height: Control.heightSm)
            }
            .accessibilityLabel(l10n("rooms.seat_stop", ["name": seat.name]))
        }
        .accessibilityIdentifier("room.seat.\(seat.id)")
    }

    private var line: String {
        let key: String
        switch seat.status {
        case .queued: key = "rooms.seat_queued"
        case .thinking: key = "rooms.seat_thinking"
        case .waitingApproval: key = "rooms.seat_waiting"
        default: key = "rooms.seat_running"
        }
        let text = l10n(key, ["name": seat.name])
        return step.map { "\(text) · \($0)" } ?? text
    }
}

/// The members sheet: the room's agents (what each is doing, the lead), its people (who is here
/// now), the invite for the manager, and Leave for everyone but the maker.
struct RoomMembersSheet: View {
    let model: RoomModel
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section(l10n("rooms.seats")) {
                ForEach(model.state.seats, id: \.id) { seat in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("@\(seat.name)").contentDirection(of: seat.name)
                            if let description = seat.description, !description.isEmpty {
                                Text(description)
                                    .font(.system(size: FontSize.sizeXs))
                                    .foregroundStyle(Tone.textMuted)
                                    .contentDirection(of: description)
                            }
                        }
                        Spacer()
                        if seat.id == model.state.leadSeatID { StatusPill(text: l10n("rooms.lead"), kind: .good) }
                        if seat.status != .idle { StatusPill(text: l10n("rooms.status_\(seat.status.rawValue)")) }
                    }
                }
            }
            Section(l10n("rooms.people")) {
                ForEach(model.state.members, id: \.id) { member in
                    HStack(spacing: Space.s2) {
                        Circle().fill(member.online ? Tone.statusRunning : Tone.textFaint).frame(width: 8, height: 8)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(member.userId == model.me ? l10n("rooms.you_name", ["name": member.name]) : member.name)
                            Text(l10n("rooms.role_\(member.role.rawValue)"))
                                .font(.system(size: FontSize.sizeXs))
                                .foregroundStyle(Tone.textMuted)
                        }
                        Spacer()
                        if model.state.canManage, member.userId != model.me, member.role != .owner {
                            Button(l10n("rooms.remove"), role: .destructive) { Task { await model.remove(member) } }
                                .buttonStyle(.borderless)
                        }
                    }
                }
            }
            if model.state.canManage {
                Section(l10n("rooms.invite")) {
                    if let code = model.state.inviteCode {
                        Text(l10n("rooms.invite_code", ["code": code]))
                            .textSelection(.enabled)
                            .accessibilityIdentifier("room.invite.code")
                    }
                    Text(l10n("rooms.invite_hint"))
                        .font(.system(size: FontSize.sizeXs))
                        .foregroundStyle(Tone.textMuted)
                    if let link = model.shareLink {
                        ShareLink(item: link) { Label(l10n("rooms.invite_share"), systemImage: "square.and.arrow.up") }
                    }
                    Button(l10n("rooms.invite_rotate")) { Task { await model.rotateInvite() } }
                }
            }
            if let error = model.actionError {
                NoticeView(text: error, tone: .danger)
            }
            if let mine = model.state.members.first(where: { $0.userId == model.me }), mine.role != .owner {
                Button(l10n("rooms.leave"), role: .destructive) {
                    Task {
                        await model.leave()
                        dismiss()
                    }
                }
                .accessibilityIdentifier("room.leave")
            }
        }
        .navigationTitle(l10n("rooms.members_title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button(l10n("common.close")) { dismiss() } }
        }
        .accessibilityIdentifier("room.members.sheet")
    }
}
