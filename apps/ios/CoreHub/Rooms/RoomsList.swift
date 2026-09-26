// The Rooms segment's list (the selector's profile, like the web's) with its two actions, New
// room and Join by code (navigation.json `rooms.actions`). A pasted invite link works as a code.
import CoreHubClient
import SwiftUI

struct RoomsList: View {
    let selected: String?
    let open: (Room) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var making = false
    @State private var joining = false
    @State private var generation = 0

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            HStack(spacing: Space.s3) {
                Button(l10n("nav.new_room")) { making = true }
                    .accessibilityIdentifier("rooms.new")
                Button(l10n("nav.join_by_code")) { joining = true }
                    .accessibilityIdentifier("rooms.join")
            }
            .font(.system(size: FontSize.sizeSm, weight: .medium))
            AsyncContent(key: "\(app.currentProfile)#\(generation)") {
                let profile = app.currentProfile
                return try await app.api.call {
                    try await RoomsAPI.roomsList(xHubProfile: profile, archived: false, limit: 100, apiConfiguration: $0)
                }.items
            } content: { rooms, _ in
                VStack(alignment: .leading, spacing: 2) {
                    if rooms.isEmpty {
                        Text(l10n("rooms.empty")).font(.system(size: FontSize.sizeSm)).foregroundStyle(Tone.textMuted)
                    }
                    ForEach(rooms, id: \.id) { room in
                        Button { open(room) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(room.name)
                                    .font(.system(size: FontSize.sizeSm, weight: .medium))
                                    .foregroundStyle(Tone.text)
                                    .lineLimit(1)
                                    .contentDirection(of: room.name)
                                Text(l10n("rooms.counts", ["seats": String(room.seats.count), "people": String(room.memberCount)]))
                                    .font(.system(size: FontSize.sizeXs))
                                    .foregroundStyle(Tone.textMuted)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, Space.s2)
                            .padding(.vertical, Space.s2)
                            .background(selected == room.id ? Tone.surface2 : Color.clear, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("room.row.\(room.id)")
                    }
                }
            }
        }
        .accessibilityIdentifier("screen.rooms")
        .sheet(isPresented: $making) {
            NavigationStack {
                NewRoomSheet { room in
                    making = false
                    generation += 1
                    open(room)
                }
            }
        }
        .sheet(isPresented: $joining) {
            NavigationStack {
                JoinRoomSheet { room in
                    joining = false
                    generation += 1
                    open(room)
                }
            }
        }
    }
}

/// A new room: its name and the agents that sit in it (the first is the lead).
struct NewRoomSheet: View {
    let made: (Room) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var chosen: [String] = []
    @State private var busy = false
    @State private var error: String?

    private var agents: [Agent] {
        app.agents.filter { $0.enabled && ($0.status == .available || $0.status == .limited) }
    }

    var body: some View {
        Form {
            Section {
                TextField(l10n("rooms.name"), text: $name)
                    .accessibilityIdentifier("rooms.new.name")
            }
            Section {
                if agents.isEmpty { Text(l10n("rooms.no_agents")).foregroundStyle(Tone.textMuted) }
                ForEach(agents, id: \.id) { agent in
                    Button {
                        if let index = chosen.firstIndex(of: agent.id) { chosen.remove(at: index) } else { chosen.append(agent.id) }
                    } label: {
                        HStack {
                            AgentAvatar(identity: .of(agent), profile: agent.profile, size: 24)
                            Text(agent.name).foregroundStyle(Tone.text)
                            Spacer()
                            if chosen.contains(agent.id) { LucideIcon(.check, size: 18).foregroundStyle(Tone.accent) }
                        }
                    }
                }
            } header: {
                Text(l10n("rooms.pick_agents"))
            } footer: {
                Text(l10n("rooms.lead_hint"))
            }
            if let error { NoticeView(text: error, tone: .danger) }
        }
        .navigationTitle(l10n("nav.new_room"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button(l10n("common.cancel")) { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(l10n("rooms.make")) { Task { await make() } }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                    .accessibilityIdentifier("rooms.new.make")
            }
        }
    }

    private func make() async {
        busy = true
        defer { busy = false }
        let profile = app.currentProfile
        let picked = chosen.compactMap { id in agents.first { $0.id == id } }
        let body = RoomCreate(name: name.trimmingCharacters(in: .whitespaces), seats: NewRoom.seats(picked))
        let key = ULID.make()
        do {
            let created = try await app.api.call {
                try await RoomsAPI.roomsCreate(xHubProfile: profile, roomCreate: body, idempotencyKey: key, apiConfiguration: $0)
            }
            made(created.room)
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }
}

/// Join by code: what the code opens first (its name, how many agents and people), then Join.
struct JoinRoomSheet: View {
    let joined: (Room) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var preview: RoomInvitePreview?
    @State private var busy = false
    @State private var error: String?

    private var code: String? { RoomLinks.code(from: input) }

    var body: some View {
        Form {
            Section {
                TextField(l10n("rooms.code_hint"), text: $input)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("rooms.join.code")
                    .onChange(of: input) { _, _ in preview = nil }
            } header: {
                Text(l10n("rooms.code"))
            }
            if let preview {
                Section {
                    Text(preview.name).contentDirection(of: preview.name)
                    Text(l10n("rooms.counts", ["seats": String(preview.seatCount), "people": String(preview.memberCount)]))
                        .foregroundStyle(Tone.textMuted)
                    if preview.alreadyMember { Text(l10n("rooms.already_member")).foregroundStyle(Tone.textMuted) }
                }
            }
            if let error { NoticeView(text: error, tone: .danger) }
        }
        .navigationTitle(l10n("nav.join_by_code"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button(l10n("common.cancel")) { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(preview == nil ? l10n("rooms.find") : (preview?.alreadyMember == true ? l10n("rooms.open") : l10n("rooms.join"))) {
                    Task {
                        if preview == nil { await find() } else { await join() }
                    }
                }
                .disabled(code == nil || busy)
                .accessibilityIdentifier("rooms.join.go")
            }
        }
    }

    private func find() async {
        guard let code else { return }
        busy = true
        defer { busy = false }
        error = nil
        do {
            preview = try await app.api.call { try await RoomsAPI.roomsPreviewInvite(inviteCode: code, apiConfiguration: $0) }
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }

    private func join() async {
        guard let code else { return }
        busy = true
        defer { busy = false }
        do {
            let room = try await app.api.call { try await RoomsAPI.roomsJoin(inviteCode: code, apiConfiguration: $0) }
            joined(room)
        } catch {
            self.error = HubFailure(error).describe(l10n)
        }
    }
}
