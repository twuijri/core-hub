import SwiftUI

/// Account Management (super-admin only): the users of this Core Hub with
/// their role, status and profile access (`/api/auth/users`).
struct AccountManagementView: View {
    @EnvironmentObject private var store: AppStore
    @State private var users: [ManagedUser] = []
    @State private var profiles: [String] = []
    @State private var loading = true
    @State private var creating = false
    @State private var editing: ManagedUser?

    var body: some View {
        List {
            if loading && users.isEmpty { ProgressView() }
            ForEach(users) { user in
                Button { editing = user } label: { row(user) }
                    .buttonStyle(.plain)
                    .swipeActions {
                        if user.id != store.currentUser?.id {
                            Button(role: .destructive) { Task { await delete(user) } } label: { Label("Delete", systemImage: "trash") }
                        }
                    }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Account Management")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { creating = true } label: { CoreHubIconView(icon: .plus, size: 20) }.accessibilityLabel("New account") } }
        .refreshable { await load() }
        .task { await load() }
        .sheet(isPresented: $creating) { ManagedUserEditor(user: nil, profiles: profiles) { await load() } }
        .sheet(item: $editing) { user in ManagedUserEditor(user: user, profiles: profiles) { await load() } }
    }

    private func row(_ user: ManagedUser) -> some View {
        HStack(spacing: 12) {
            ProfileAvatar(name: user.username, size: 34)
            VStack(alignment: .leading, spacing: 3) {
                Text(user.username).font(CoreHubTokens.Typography.sessionTitleFont).foregroundStyle(CoreHubTokens.Palette.textPrimary)
                Text(user.profiles.isEmpty ? String(localized: "All profiles") : user.profiles.joined(separator: ", "))
                    .font(CoreHubTokens.Typography.metaFont)
                    .foregroundStyle(CoreHubTokens.Palette.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if user.isSuperAdmin { StatusPill(text: String(localized: "Super admin"), color: CoreHubTokens.Palette.info) }
            StatusPill(text: user.isActive ? String(localized: "Active") : String(localized: "Disabled"), color: user.isActive ? CoreHubTokens.Palette.success : CoreHubTokens.Palette.textMuted)
        }
        .contentShape(Rectangle())
    }

    private func load() async {
        loading = true
        if let result = await store.attempt({ try await store.api.managedUsers() }) {
            users = result.users
            profiles = result.profiles
        }
        loading = false
    }

    private func delete(_ user: ManagedUser) async {
        guard await store.attempt({ try await store.api.deleteManagedUser(user.id) }) != nil else { return }
        users.removeAll { $0.id == user.id }
    }
}

/// Creates or edits one account. The password is only sent when it is
/// filled in, so editing never clears an existing one.
struct ManagedUserEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let user: ManagedUser?
    let profiles: [String]
    let reload: () async -> Void

    @State private var username = ""
    @State private var password = ""
    @State private var role = "admin"
    @State private var active = true
    @State private var selected: Set<String> = []
    @State private var defaultProfile = ""
    @State private var state: SaveState = .idle

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    TextField("Username", text: $username).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if user == nil { SecureField("Password", text: $password) }
                    else { SecureField("New password (optional)", text: $password) }
                    Picker("Role", selection: $role) {
                        Text("Administrator").tag("admin")
                        Text("Super administrator").tag("super_admin")
                    }
                    Toggle("Active", isOn: $active)
                }
                Section {
                    ForEach(profiles, id: \.self) { profile in
                        Button { toggle(profile) } label: {
                            HStack {
                                Text(profile).foregroundStyle(CoreHubTokens.Palette.textPrimary)
                                Spacer(minLength: 0)
                                if selected.contains(profile) { CoreHubIconView(icon: .check, size: 14).foregroundStyle(CoreHubTokens.Palette.success) }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    Picker("Default profile", selection: $defaultProfile) {
                        Text("None").tag("")
                        ForEach(profiles, id: \.self) { Text($0).tag($0) }
                    }
                } header: { Text("Profiles") } footer: { Text("Leave every profile unselected to grant access to all of them.") }
                Section { SaveStateLabel(state: state) }
            }
            .navigationTitle(user == nil ? Text("New account") : Text("Edit account"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(!canSave) }
            }
            .onAppear(perform: fill)
        }
    }

    private var canSave: Bool {
        guard !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !state.isSaving else { return false }
        return user != nil || !password.isEmpty
    }

    private func fill() {
        guard let user else { return }
        username = user.username
        role = user.role
        active = user.isActive
        selected = Set(user.profiles)
        defaultProfile = user.defaultProfile
    }

    private func toggle(_ profile: String) {
        if selected.contains(profile) { selected.remove(profile) } else { selected.insert(profile) }
    }

    private func save() async {
        state = .saving
        let body = APIClient.managedUserBody(username: username, password: password, role: role, status: active ? "active" : "disabled", profiles: Array(selected), defaultProfile: defaultProfile)
        do {
            if let user { try await store.api.updateManagedUser(user.id, body: body) }
            else { try await store.api.createManagedUser(body) }
            state = .saved
            await reload()
            dismiss()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
