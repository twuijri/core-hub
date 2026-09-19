import SwiftUI

/// The Group Chat root: every room the account can open, with create,
/// join-by-code, clone and delete (web `GroupChatRoomList.vue`).
struct GroupsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var rooms: [Room] = []
    @State private var loading = true
    @State private var renaming: Room?
    @State private var renameText = ""

    var body: some View {
        List {
            if loading && rooms.isEmpty { ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear) }
            if !loading && rooms.isEmpty {
                EmptyState(icon: "person.3", title: "No groups", detail: "Create a room where people and agents work together, or join one with an invite code.")
                    .listRowBackground(Color.clear)
            }
            ForEach(rooms) { room in
                Button { store.open(room) } label: {
                    RoomRowView(room: room, selected: store.selectedRoom?.id == room.id, time: SessionTimeFormatter.string(for: room.updatedAt ?? "", locale: store.locale))
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets(top: 2, leading: 8, bottom: 2, trailing: 8))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .contextMenu { menu(for: room) }
                .swipeActions {
                    Button(role: .destructive) { Task { await delete(room) } } label: { Label("Delete", systemImage: "trash") }
                    Button { Task { await clone(room) } } label: { Label("Duplicate", systemImage: "doc.on.doc") }.tint(CoreHubTokens.Palette.info)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .navigationTitle("Group Chat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { store.roomAction = .join } label: { Image(systemName: "link") }.accessibilityLabel("Join by code")
                Button { store.roomAction = .create } label: { CoreHubIconView(icon: .plus, size: 20) }.accessibilityLabel("New room")
            }
        }
        .refreshable { await load() }
        .task(id: store.sessionListVersion) { await load() }
        .alert("Rename room", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $renameText)
            Button("Save") { Task { await rename() } }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder private func menu(for room: Room) -> some View {
        Button { renaming = room; renameText = room.name } label: { Label("Rename", systemImage: "pencil") }
        Button { Task { await clone(room) } } label: { Label("Duplicate", systemImage: "doc.on.doc") }
        Button(role: .destructive) { Task { await delete(room) } } label: { Label("Delete", systemImage: "trash") }
    }

    private func load() async {
        loading = true
        rooms = (await store.attempt { try await store.api.rooms() }) ?? rooms
        loading = false
    }

    private func delete(_ room: Room) async {
        guard await store.attempt({ try await store.api.deleteRoom(room.id) }) != nil else { return }
        rooms.removeAll { $0.id == room.id }
        if store.selectedRoom?.id == room.id { store.selectedRoom = nil }
        store.roomsChanged()
    }

    private func clone(_ room: Room) async {
        guard let copy = await store.attempt({ try await store.api.cloneRoom(room.id, name: nil, inviteCode: RoomInviteLink.generateCode()) }) else { return }
        rooms.insert(copy, at: 0)
        store.roomsChanged()
    }

    private func rename() async {
        guard let room = renaming else { return }
        var draft = RoomConfigDraft(room: room)
        draft.name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !draft.name.isEmpty else { return }
        guard let updated = await store.attempt({ try await store.api.updateRoomConfig(room.id, config: draft.body) }) else { return }
        if let index = rooms.firstIndex(where: { $0.id == room.id }) { rooms[index] = updated }
        if store.selectedRoom?.id == room.id { store.selectedRoom = updated }
        renaming = nil
        store.roomsChanged()
    }
}

// MARK: - Create

/// "New room": name, invite code, workspace, the required summary settings
/// and the agent seats (from presets or configured by hand).
struct CreateRoomView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft = RoomCreateDraft()
    @State private var models: [ModelOption] = []
    @State private var editing: RoomAgentDraftEdit?
    @State private var addingAgent = false
    @State private var saving = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Form {
                roomSection
                summarySection
                agentsSection
                if !error.isEmpty { Section { Text(error).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.error) } }
            }
            .navigationTitle("New room")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Creating…" : "Create") { Task { await create() } }.disabled(saving)
                }
            }
            .sheet(isPresented: $addingAgent) {
                RoomAgentEditorView(input: RoomAgentInput(), models: models) { input in draft.agents.append(input) }
            }
            .sheet(item: $editing) { item in
                RoomAgentEditorView(input: item.input, models: models) { input in
                    if draft.agents.indices.contains(item.id) { draft.agents[item.id] = input }
                }
            }
            .task { await load() }
        }
    }

    private var roomSection: some View {
        Section("Room") {
            TextField("Name", text: $draft.name)
            HStack {
                TextField("Invite code", text: $draft.inviteCode).textInputAutocapitalization(.characters).autocorrectionDisabled()
                Button { draft.inviteCode = RoomInviteLink.generateCode() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).accessibilityLabel("Generate invite code")
            }
            TextField("Workspace path", text: $draft.workspace).textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("Your name in this room", text: $draft.memberName)
        }
    }

    private var summarySection: some View {
        Section {
            Picker("Profile", selection: $draft.summaryProfile) { ForEach(store.profiles) { Text($0.name).tag($0.name) } }
            Picker("Model", selection: $draft.summaryModel) {
                Text("Profile default").tag("")
                ForEach(models) { Text($0.name).tag($0.id) }
            }
            Stepper("Summarize every \(draft.summaryEveryTurns) turns", value: $draft.summaryEveryTurns, in: RoomCreateDraft.turnRange)
        } header: { Text("Summary") } footer: { Text("Core Hub keeps a rolling summary so long rooms stay inside the model context.") }
    }

    private var agentsSection: some View {
        Section("Agents") {
            ForEach(Array(draft.agents.enumerated()), id: \.offset) { index, agent in
                Button { editing = RoomAgentDraftEdit(id: index, input: agent) } label: { RoomAgentSummaryRow(input: agent) }.buttonStyle(.plain)
            }
            .onDelete { offsets in draft.agents.remove(atOffsets: offsets) }
            Button { addingAgent = true } label: { Label("Add agent", systemImage: "plus.circle") }
        }
    }

    private func load() async {
        if draft.summaryProfile.isEmpty { draft.summaryProfile = store.selectedProfile }
        if draft.memberName.isEmpty { draft.memberName = store.currentUser?.username ?? "" }
        models = (await store.attempt { try await store.api.models(profile: store.selectedProfile) }) ?? []
        if draft.summaryProvider.isEmpty, let match = models.first(where: { $0.id == draft.summaryModel }) { draft.summaryProvider = match.provider }
    }

    private func create() async {
        if let problem = draft.validationError { error = problem; return }
        error = ""
        saving = true
        defer { saving = false }
        draft.summaryProvider = models.first { $0.id == draft.summaryModel }?.provider ?? draft.summaryProvider
        guard let room = await store.attempt({
            try await store.api.createRoom(name: draft.name, inviteCode: draft.inviteCode, agents: draft.agents, summary: draft.summaryBody, workspace: draft.workspace.nilIfEmpty, memberName: draft.memberName.nilIfEmpty)
        }) else { return }
        store.roomsChanged()
        store.open(room)
        dismiss()
    }
}

/// One agent seat of a draft opened in the editor sheet.
struct RoomAgentDraftEdit: Identifiable, Equatable {
    let id: Int
    var input: RoomAgentInput
}

struct RoomAgentSummaryRow: View {
    let input: RoomAgentInput

    var body: some View {
        HStack(spacing: 10) {
            AgentAvatarView(asset: AgentAvatarAsset.resolve(runtime: input.agent, source: input.agent == "hermes" ? "cli" : "coding_agent"), size: 26)
            VStack(alignment: .leading, spacing: 2) {
                DirectionalText(text: input.name.nilIfEmpty ?? input.profile, font: CoreHubTokens.Typography.font(CoreHubTokens.Typography.sessionTitle, weight: .medium))
                TechnicalText(text: [input.agent, input.profile, input.model].filter { !$0.isEmpty }.joined(separator: " · "))
            }
            Spacer(minLength: 0)
            if !input.isValid { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(CoreHubTokens.Palette.warning) }
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Join

/// "Join by code": resolves `GET /group-chat/rooms/join/{code}` and opens the
/// room. Also accepts a pasted `…/share/group-chat/{code}` link.
struct JoinRoomView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var resolved: Room?
    @State private var checking = false
    @State private var error = ""

    private var normalized: String {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = trimmed.split(separator: "/").last else { return trimmed }
        return String(last)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Invite code or link", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .environment(\.layoutDirection, .leftToRight)
                    Button { Task { await check() } } label: {
                        HStack { if checking { ProgressView().controlSize(.small) }; Text("Find room") }
                    }
                    .disabled(normalized.isEmpty || checking)
                } footer: { Text("Ask a room member for the invite code, or scan the QR code in the room settings.") }
                if let resolved {
                    Section("Room") {
                        RoomRowView(room: resolved)
                        Button { store.open(resolved); store.roomsChanged(); dismiss() } label: { Label("Open room", systemImage: "arrow.forward.circle") }
                    }
                }
                if !error.isEmpty { Section { Text(error).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.error) } }
            }
            .navigationTitle("Join a room")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func check() async {
        checking = true
        defer { checking = false }
        do {
            resolved = try await store.api.resolveInvite(normalized)
            error = ""
        } catch {
            resolved = nil
            self.error = error.localizedDescription
        }
    }
}
