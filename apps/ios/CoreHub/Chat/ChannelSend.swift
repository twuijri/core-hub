// Writing into a Telegram or WhatsApp conversation from the phone (contract decision §153), the
// web's ChannelComposer and channels.ts: an admin types, the hub posts the words on the channel as
// «من كور هب (<name>): …» and then hands them to the agent, which answers there. The words show at
// once with what became of them (posted → delivered → answering → answered, or failed), then as the
// "<name> · from Core Hub" message in the transcript. Where the conversation cannot be written into,
// the composer's place says why. The hub announces each turn as `channel_conversation.updated`; the
// polling stays as a slow fallback while it does, and as it was on an older hub that announces
// nothing. The rules are here, apart from the views, so ChannelSendTests checks them.
import CoreHubClient
import Foundation

/// One `channel_conversation.updated` (contract `events/sessions`).
struct ChannelUpdate: Decodable, Equatable {
    let conversationID: String
    let channel: String
    let reason: String
    let outgoing: ChannelOutgoing?

    private enum CodingKeys: String, CodingKey {
        case conversationID = "conversation_id"
        case channel, reason, outgoing
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        conversationID = try container.decode(String.self, forKey: .conversationID)
        reason = try container.decode(String.self, forKey: .reason)
        channel = (try? container.decodeIfPresent(String.self, forKey: .channel)) ?? ""
        // A message this app cannot read moves nothing, but the turn is still news.
        outgoing = try? container.decodeIfPresent(ChannelOutgoing.self, forKey: .outgoing)
    }
}

/// The words on their way to the channel, shown before the hub answers.
struct ChannelSending: Equatable {
    let key: String
    let text: String
}

/// What stands where the composer would be.
enum ChannelBottom: Equatable {
    /// An admin, on a conversation the hub can write into.
    case composer
    /// Why not, in plain words; with `not_current`, the conversation a message would go to.
    case unavailable(ChannelSendUnavailable, currentID: String?)
    /// An older hub, or one that does not run Hermes: the read-only banner, as before.
    case readOnly
}

/// A refused send, as the screen says it.
enum ChannelSendRefusal: Equatable {
    /// The channel itself refused the words (nothing reached the agent), in its own words.
    case channel(String)
    /// The hub would not send (the same reasons `can_send` gives beforehand).
    case unavailable(ChannelSendUnavailable)
    /// Anything else: offline, a validation error…
    case other(HubFailure)
}

enum ChannelSendRules {
    /// The realtime event that says a channel conversation changed (§153).
    static let event = "channel_conversation.updated"
    /// The most words the hub takes in one message.
    static let textMax = 4000
    /// Between two reads, as before (§61) and while the hub announces each change itself — then
    /// only a fallback (the web's intervals).
    static let listEvery: UInt64 = 45_000_000_000
    static let transcriptEvery: UInt64 = 30_000_000_000
    static let liveListEvery: UInt64 = 300_000_000_000
    static let liveTranscriptEvery: UInt64 = 120_000_000_000

    /// Nanoseconds between two reads of the channel list.
    static func listPoll(live: Bool?) -> UInt64 { live == true ? liveListEvery : listEvery }
    /// Nanoseconds between two reads of an open transcript.
    static func transcriptPoll(live: Bool?) -> UInt64 { live == true ? liveTranscriptEvery : transcriptEvery }

    /// The composer for whoever may write (the hub says so per caller in `can_send`); otherwise
    /// why not. A hub without the fields (older), or one that does not run Hermes, reads as it
    /// always did (§61).
    static func bottom(_ conversation: ChannelConversation) -> ChannelBottom {
        if conversation.canSend == true { return .composer }
        guard let reason = conversation.sendUnavailable, reason != .hermesNotManaged else { return .readOnly }
        return .unavailable(reason, currentID: reason == .notCurrent ? conversation.currentId : nil)
    }

    /// The words as they go: trimmed, at most `textMax`; nil when there is nothing to send.
    static func words(_ typed: String) -> String? {
        let trimmed = String(typed.trimmingCharacters(in: .whitespacesAndNewlines).prefix(textMax))
        return trimmed.isEmpty ? nil : trimmed
    }

    @MainActor private static var counter = 0

    /// The phone's own id for a message (`client_message_id`), given back in `ChannelOutgoing`.
    @MainActor
    static func clientID(now: Date = Date()) -> String {
        counter += 1
        return "i-\(String(Int(now.timeIntervalSince1970 * 1000), radix: 36))-\(counter)"
    }

    /// A message written from the hub, put into the list as it now stands (by its id), oldest first.
    static func upsert(_ list: [ChannelOutgoing], _ outgoing: ChannelOutgoing) -> [ChannelOutgoing] {
        guard list.contains(where: { $0.id == outgoing.id }) else { return list + [outgoing] }
        return list.map { $0.id == outgoing.id ? outgoing : $0 }
    }

    /// What the hub still follows, against the transcript shown: a message the transcript has shows
    /// its state under it (`followed`, by message id); one it does not have yet is drawn after the
    /// rest (`pending`).
    static func split(_ messages: [ChannelMessage], _ outgoing: [ChannelOutgoing]) -> (followed: [String: ChannelOutgoing], pending: [ChannelOutgoing]) {
        let shown = Set(messages.map(\.id))
        var followed: [String: ChannelOutgoing] = [:]
        var pending: [ChannelOutgoing] = []
        for each in outgoing {
            if let id = each.messageId, shown.contains(id) { followed[id] = each } else { pending.append(each) }
        }
        return (followed, pending)
    }

    /// Whether the words on their way still need their own bubble (the hub's answer has not taken
    /// their place).
    static func showSending(_ sending: ChannelSending?, pending: [ChannelOutgoing]) -> Bool {
        guard let sending else { return false }
        return !pending.contains { $0.clientMessageId == sending.key }
    }

    /// Whether a transcript message was written from the hub (drawn on the owner's side, named).
    static func fromHub(_ message: ChannelMessage) -> Bool {
        message.role == .user && message.origin == .hub
    }

    /// A message starts a new turn under its own name unless the same side wrote the one before,
    /// from the same place (a message from the hub never runs on from the person's on the channel).
    static func startsTurn(_ previous: ChannelMessage?, _ message: ChannelMessage) -> Bool {
        guard let previous else { return true }
        return previous.role != message.role || (previous.origin ?? .channel) != (message.origin ?? .channel)
    }

    /// `channel_conversation.updated` read from its envelope; nil for any other event or a malformed one.
    static func parse(_ envelope: Envelope) -> ChannelUpdate? {
        guard envelope.event == event, envelope.namespace == "/rt/sessions" else { return nil }
        return try? HubJSON.decoder.decode(ChannelUpdate.self, from: envelope.payload)
    }

    /// Whether the screens have something new to read: a turn began or ended, or the hub's message
    /// reached its end (answered or failed). A step in between only moves the status line.
    static func settled(_ update: ChannelUpdate) -> Bool {
        update.reason != "outgoing" || update.outgoing?.status == .answered || update.outgoing?.status == .failed
    }

    /// What an open transcript does with an update: its outgoing as it now stands, and whether to
    /// read again.
    static func apply(conversationID: String, outgoing: [ChannelOutgoing], update: ChannelUpdate) -> (outgoing: [ChannelOutgoing], refetch: Bool) {
        let mine = update.conversationID == conversationID || update.outgoing?.conversationId == conversationID
        guard mine else { return (outgoing, false) }
        let next = update.outgoing.map { upsert(outgoing, $0) } ?? outgoing
        return (next, settled(update))
    }

    /// A refused send, in the screen's terms.
    static func refusal(_ failure: HubFailure) -> ChannelSendRefusal {
        if failure.reason == "channel_send_failed" { return .channel(failure.detailMessage ?? "") }
        if let reason = failure.reason.flatMap(ChannelSendUnavailable.init(rawValue:)) { return .unavailable(reason) }
        return .other(failure)
    }

    /// Why a channel conversation cannot be written into, in the reader's words.
    static func unavailableText(_ reason: ChannelSendUnavailable, channel: String, _ l10n: L10n) -> String {
        l10n("channel_send.unavailable_\(reason.rawValue)", ["channel": channel])
    }

    /// A refused send in plain words.
    static func refusalText(_ refusal: ChannelSendRefusal, channel: String, _ l10n: L10n) -> String {
        switch refusal {
        case .channel(let message): return l10n("channel_send.error_channel", ["channel": channel, "message": message])
        case .unavailable(let reason): return unavailableText(reason, channel: channel, l10n)
        case .other(let failure): return failure.describe(l10n)
        }
    }

    /// The line under a message written from the hub: what became of it (nil: «Sending…»); nothing
    /// once answered. `failed` marks a line drawn in the danger colour.
    static func statusLine(_ status: ChannelOutgoing?, channel: String, _ l10n: L10n) -> (text: String, failed: Bool)? {
        guard let status else { return (l10n("channel_send.status_sending", ["channel": channel]), false) }
        switch status.status {
        case .answered: return nil
        case .posted: return (l10n("channel_send.status_posted", ["channel": channel]), false)
        case .delivered: return (l10n("channel_send.status_delivered"), false)
        case .answering: return (l10n("channel_send.status_answering", ["channel": channel]), false)
        case .failed:
            let reason = status.error?.reason ?? .notPickedUp
            let why = l10n("channel_send.failed_\(reason.rawValue)", ["channel": channel])
            if let message = status.error?.message, !message.isEmpty { return ("\(why) (\(message))", true) }
            return (why, true)
        }
    }
}
