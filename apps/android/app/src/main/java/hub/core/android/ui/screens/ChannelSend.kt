package hub.core.android.ui.screens

import hub.core.android.data.HubError
import hub.core.android.realtime.Envelope
import hub.core.android.realtime.SESSIONS_NAMESPACE
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.ChannelConversation
import hub.core.client.model.ChannelMessage
import hub.core.client.model.ChannelOutgoing
import hub.core.client.model.ChannelSendUnavailable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/*
 * Writing into a Telegram or WhatsApp conversation from the phone (contract decision §153), the
 * web's ChannelComposer and channels.ts: an admin types, the hub posts the words on the channel as
 * «من كور هب (<name>): …» and then hands them to the agent, which answers there. The words show at
 * once with what became of them (posted → delivered → answering → answered, or failed), then as
 * the "<name> · from Core Hub" message in the transcript. Where the conversation cannot be written
 * into, the composer's place says why. The hub announces each turn as
 * `channel_conversation.updated`; the polling stays as a slow fallback while it does, and as it was
 * on an older hub that announces nothing. The rules are here, apart from the Compose, so
 * ChannelSendTest checks them.
 */

/** One `channel_conversation.updated` (contract `events/sessions`). */
data class ChannelUpdate(
    val conversationId: String,
    val channel: String,
    val reason: String,
    val outgoing: ChannelOutgoing?,
)

/** The words on their way to the channel, shown before the hub answers. */
data class ChannelSending(val key: String, val text: String)

/** What stands where the composer would be. */
sealed interface ChannelBottom {
    /** An admin, on a conversation the hub can write into. */
    data object Composer : ChannelBottom

    /** Why not, in plain words; with `not_current`, the conversation a message would go to. */
    data class Unavailable(val reason: ChannelSendUnavailable, val currentId: String?) : ChannelBottom

    /** An older hub, or one that does not run Hermes: the read-only banner, as before. */
    data object ReadOnly : ChannelBottom
}

/** A refused send, as the screen says it. */
sealed interface ChannelSendRefusal {
    /** The channel itself refused the words (nothing reached the agent), in its own words. */
    data class Channel(val message: String) : ChannelSendRefusal

    /** The hub would not send (the same reasons `can_send` gives beforehand). */
    data class Unavailable(val reason: ChannelSendUnavailable) : ChannelSendRefusal

    /** Anything else: offline, a validation error… */
    data class Other(val error: HubError) : ChannelSendRefusal
}

object ChannelSendRules {
    /** The realtime event that says a channel conversation changed (§153). */
    const val EVENT = "channel_conversation.updated"
    /** The most words the hub takes in one message. */
    const val TEXT_MAX = 4000
    /** The list and the transcript, while the hub announces each change itself: only a fallback (the web's). */
    const val LIVE_POLL_MS = 5 * 60_000L
    const val LIVE_TRANSCRIPT_POLL_MS = 2 * 60_000L

    /** Between two reads of the channel list: slow while the hub says it announces changes. */
    fun listPollMs(liveUpdates: Boolean?): Long = if (liveUpdates == true) LIVE_POLL_MS else ChatGroupsRules.POLL_MS

    /** Between two reads of an open transcript. */
    fun transcriptPollMs(liveUpdates: Boolean?): Long =
        if (liveUpdates == true) LIVE_TRANSCRIPT_POLL_MS else ChatGroupsRules.TRANSCRIPT_POLL_MS

    /**
     * The composer for whoever may write (the hub says so per caller in `can_send`); otherwise why
     * not. A hub without the fields (older), or one that does not run Hermes, reads as it always
     * did (§61).
     */
    fun bottom(conversation: ChannelConversation): ChannelBottom {
        if (conversation.canSend == true) return ChannelBottom.Composer
        val reason = conversation.sendUnavailable
        if (reason == null || reason == ChannelSendUnavailable.HERMES_NOT_MANAGED) return ChannelBottom.ReadOnly
        return ChannelBottom.Unavailable(reason, conversation.currentId.takeIf { reason == ChannelSendUnavailable.NOT_CURRENT })
    }

    /** The words as they go: trimmed, at most [TEXT_MAX]; null when there is nothing to send. */
    fun words(typed: String): String? = typed.trim().take(TEXT_MAX).takeIf { it.isNotEmpty() }

    private var counter = 0

    /** The phone's own id for a message (`client_message_id`), given back in `ChannelOutgoing`. */
    @Synchronized
    fun clientId(now: Long = System.currentTimeMillis()): String {
        counter += 1
        return "a-${now.toString(36)}-$counter"
    }

    /** A message written from the hub, put into the list as it now stands (by its id), oldest first. */
    fun upsert(list: List<ChannelOutgoing>, outgoing: ChannelOutgoing): List<ChannelOutgoing> =
        if (list.any { it.id == outgoing.id }) list.map { if (it.id == outgoing.id) outgoing else it } else list + outgoing

    /**
     * What the hub still follows, against the transcript shown: a message the transcript has
     * shows its state under it ([followed], by message id); one it does not have yet is drawn
     * after the rest ([pending]).
     */
    data class Split(val followed: Map<String, ChannelOutgoing>, val pending: List<ChannelOutgoing>)

    fun split(messages: List<ChannelMessage>, outgoing: List<ChannelOutgoing>): Split {
        val shown = messages.map { it.id }.toSet()
        val followed = outgoing.filter { it.messageId != null && it.messageId in shown }.associateBy { it.messageId!! }
        return Split(followed, outgoing.filter { it.messageId == null || it.messageId !in shown })
    }

    /** Whether the words on their way still need their own bubble (the hub's answer has not taken its place). */
    fun showSending(sending: ChannelSending?, pending: List<ChannelOutgoing>): Boolean =
        sending != null && pending.none { it.clientMessageId == sending.key }

    /** Whether a transcript message was written from the hub (drawn on the owner's side, named). */
    fun fromHub(message: ChannelMessage): Boolean = message.role == ChannelMessage.Role.USER && message.origin == ChannelMessage.Origin.HUB

    /** `channel_conversation.updated` read from its envelope; null for any other event or a malformed one. */
    fun parse(envelope: Envelope): ChannelUpdate? {
        if (envelope.event != EVENT || envelope.namespace != SESSIONS_NAMESPACE) return null
        val payload = envelope.payload
        val id = (payload["conversation_id"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null
        val reason = (payload["reason"] as? JsonPrimitive)?.contentOrNull ?: return null
        val channel = (payload["channel"] as? JsonPrimitive)?.contentOrNull.orEmpty()
        val outgoing = payload["outgoing"]?.takeIf { it !is JsonNull }?.let {
            runCatching { Serializer.kotlinxSerializationJson.decodeFromJsonElement(ChannelOutgoing.serializer(), it) }.getOrNull()
        }
        return ChannelUpdate(id, channel, reason, outgoing)
    }

    /**
     * Whether the screens have something new to read: a turn began or ended, or the hub's message
     * reached its end (answered or failed). A step in between only moves the status line.
     */
    fun settled(update: ChannelUpdate): Boolean =
        update.reason != "outgoing" ||
            update.outgoing?.status == ChannelOutgoing.Status.ANSWERED ||
            update.outgoing?.status == ChannelOutgoing.Status.FAILED

    /** What an open transcript does with an update: its outgoing as it now stands, and whether to read again. */
    data class Applied(val outgoing: List<ChannelOutgoing>, val refetch: Boolean)

    fun apply(conversationId: String, outgoing: List<ChannelOutgoing>, update: ChannelUpdate): Applied {
        val mine = update.conversationId == conversationId || update.outgoing?.conversationId == conversationId
        if (!mine) return Applied(outgoing, false)
        val next = update.outgoing?.let { upsert(outgoing, it) } ?: outgoing
        return Applied(next, settled(update))
    }

    /** A refused send, in the screen's terms. */
    fun failure(error: HubError): ChannelSendRefusal {
        if (error.reason == "channel_send_failed") return ChannelSendRefusal.Channel(error.detailMessage.orEmpty())
        val reason = error.reason?.let { ChannelSendUnavailable.decode(it) }
        return if (reason != null) ChannelSendRefusal.Unavailable(reason) else ChannelSendRefusal.Other(error)
    }
}
