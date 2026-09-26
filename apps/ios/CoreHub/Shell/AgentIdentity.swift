// Who an agent is on screen: its name as the hub's registry has it (a reply's author is only an
// id and the placeholder «agent»), its catalog slug for its mark (the web's `agentMark`, written
// into the asset catalog by scripts/icons/agent-marks-mobile.mjs), and whether it has a picture of
// its own (`agents.getAvatar`, DECISIONS §76).
import CoreHubClient
import Observation
import SwiftUI
import UIKit

struct AgentIdentity: Equatable {
    /// What the hub writes as an agent message's author name when it names nobody.
    static let placeholder = "agent"

    let id: String?
    let name: String
    let slug: String?
    let hasPicture: Bool

    /// The identity of an author. `shownName` is the name the message carries: a room seat's own
    /// name wins over the agent's; a chat reply's placeholder never does.
    static func of(authorID: String?, shownName: String?, agents: [Agent], fallback: String) -> AgentIdentity {
        let agent = agents.first { $0.id == authorID }
        let shown = shownName?.trimmingCharacters(in: .whitespaces) ?? ""
        let name: String
        if !shown.isEmpty, shown != placeholder {
            name = shown
        } else if let registry = agent?.name, !registry.trimmingCharacters(in: .whitespaces).isEmpty {
            name = registry
        } else {
            name = fallback
        }
        return AgentIdentity(id: authorID, name: name, slug: agent?.slug, hasPicture: agent?.avatar.kind == .image)
    }

    static func of(_ agent: Agent) -> AgentIdentity {
        AgentIdentity(id: agent.id, name: agent.name, slug: agent.slug, hasPicture: agent.avatar.kind == .image)
    }
}

/// The agents of each profile, read once and kept while the app runs, and the pictures of those
/// that have one.
@MainActor
@Observable
final class AgentDirectory {
    private(set) var byProfile: [String: [Agent]] = [:]
    private(set) var pictures: [String: UIImage] = [:]
    @ObservationIgnored private var loading: Set<String> = []
    @ObservationIgnored private var fetching: Set<String> = []
    @ObservationIgnored weak var app: AppModel?

    func agents(_ profile: String) -> [Agent] {
        if byProfile[profile] == nil { ensure(profile) }
        return byProfile[profile] ?? []
    }

    func put(_ profile: String, _ agents: [Agent]) { byProfile[profile] = agents }

    func ensure(_ profile: String) {
        guard byProfile[profile] == nil, !loading.contains(profile), let app else { return }
        loading.insert(profile)
        Task {
            defer { loading.remove(profile) }
            if let list = try? await app.api.call({ try await AgentsAPI.agentsList(xHubProfile: profile, apiConfiguration: $0) }) {
                byProfile[profile] = list.items
            }
        }
    }

    /// The picture the hub keeps for an agent, fetched once.
    func picture(_ agentID: String, profile: String) -> UIImage? {
        if let image = pictures[agentID] { return image }
        guard !fetching.contains(agentID), let app else { return nil }
        fetching.insert(agentID)
        Task {
            if let url = try? await app.api.call({ try await AgentsAPI.agentsGetAvatar(xHubProfile: profile, agentId: agentID, apiConfiguration: $0) }),
               let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
                pictures[agentID] = image
            }
        }
        return nil
    }

    func forget() {
        byProfile = [:]
        pictures = [:]
    }
}

/// An agent's face: its own picture when it has one, else the mark of an agent we ship
/// (Hermes, Claude Code, Codex …), else its initial.
struct AgentAvatar: View {
    let identity: AgentIdentity
    let profile: String
    var size: CGFloat = 24
    @Environment(AppModel.self) private var app

    var body: some View {
        ZStack {
            Circle().fill(Tone.accentSoft)
            if identity.hasPicture, let id = identity.id, let image = app.agentDirectory.picture(id, profile: profile) {
                Image(uiImage: image).resizable().scaledToFill()
            } else if let mark = AgentMarks.image(identity.slug) {
                mark.resizable().scaledToFit()
                    .frame(width: size * 0.62, height: size * 0.62)
                    .foregroundStyle(Tone.accentSoftText)
            } else {
                Text(String(identity.name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
                    .font(.system(size: size * 0.45, weight: .bold))
                    .foregroundStyle(Tone.accentSoftText)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
        .accessibilityIdentifier("agent.avatar")
    }
}
