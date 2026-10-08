package hub.core.android.ui.screens

import hub.core.android.data.HubApis
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.client.api.SessionsApi
import hub.core.client.model.ChannelContinuation
import hub.core.client.model.ChannelContinueRequest
import hub.core.client.model.ChannelConversation
import hub.core.client.model.ChannelConversationsUnavailable
import hub.core.client.model.ChannelMessagePreview
import hub.core.client.model.Session
import hub.core.client.model.SessionCategory
import hub.core.client.model.SessionCategoryInput
import hub.core.client.model.SessionPatch
import hub.core.client.model.SessionSource
import hub.core.client.model.SessionsListChannelMessages200Response
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/*
 * The chats list in groups, as on the web (contract decisions §60, §61, §88, §103): the profile's
 * categories first, in their order, then one group per messaging channel — the hub's chats that
 * came from Telegram, WhatsApp… together with the conversations Hermes keeps for that channel
 * (an admin may write into a Telegram or WhatsApp one, §153) — then everything else. The pinned chats keep their own section at the top on the
 * phone. Native since 2026-09-27: before, the phone had neither categories nor channel
 * conversations. The rules are here, apart from the Compose (ChatGroupsUi.kt), so
 * SelfSufficientTest checks them.
 */

/** One group of the list. */
sealed interface ChatGroup {
    val key: String
    val items: List<Session>

    data class Category(val category: SessionCategory, override val items: List<Session>) : ChatGroup {
        override val key get() = "category:${category.id}"
    }

    data class Channel(val channel: String, override val items: List<Session>, val conversations: List<ChannelConversation>) : ChatGroup {
        override val key get() = "channel:$channel"
    }

    data class Rest(override val items: List<Session>) : ChatGroup {
        override val key get() = "rest"
    }
}

object ChatGroupsRules {
    /** Each profile's most recent this many channel conversations (the hub's default, §103). */
    const val CHANNEL_PAGE = 100
    /** The most the hub lists per profile. */
    const val CHANNEL_MAX = 1000
    /** Between two reads of the channel conversations while the list is on screen (the web's). */
    const val POLL_MS = 45_000L
    /** Between two reads of an open transcript. */
    const val TRANSCRIPT_POLL_MS = 30_000L
    const val NAME_MAX = 60

    /** The web's eight category colours, by name. */
    val COLOURS: List<Pair<String, String>> = listOf(
        "blue" to "#3b82f6", "green" to "#22a06b", "amber" to "#d97706", "red" to "#dc2626",
        "purple" to "#8b5cf6", "pink" to "#db2777", "teal" to "#0d9488", "slate" to "#64748b",
    )

    private val HEX = Regex("^#[0-9a-fA-F]{6}$")

    fun validColour(color: String?): Boolean = color != null && HEX.matches(color)

    /** A category name as the hub takes it (1–60 characters after trimming), or null. */
    fun name(typed: String): String? = typed.trim().takeIf { it.isNotEmpty() && it.length <= NAME_MAX }

    /**
     * Which group a chat sits in: a category the person chose wins over where the chat came from;
     * a category this list does not know yet is no group rather than a hidden row.
     */
    fun keyOf(session: Session, known: Set<String>): String = when {
        session.categoryId != null && session.categoryId in known -> "category:${session.categoryId}"
        session.source == SessionSource.CHANNEL -> "channel:${session.channel ?: "other"}"
        else -> "rest"
    }

    /** Telegram, then WhatsApp, then any other channel by name. */
    private fun rank(channel: String): Int = listOf("telegram", "whatsapp").indexOf(channel).let { if (it == -1) 2 else it }

    /**
     * The groups, in the order they are shown. Every category is listed even when empty (it is
     * where a chat is moved to) unless [keepEmpty] is false. Channel groups exist only when a chat
     * or a conversation came from that channel. The rest is last.
     */
    fun group(
        sessions: List<Session>,
        categories: List<SessionCategory>,
        conversations: List<ChannelConversation> = emptyList(),
        keepEmpty: Boolean = true,
    ): List<ChatGroup> {
        val known = categories.map { it.id }.toSet()
        val buckets = sessions.groupBy { keyOf(it, known) }
        val groups = mutableListOf<ChatGroup>()
        for (category in ordered(categories)) {
            val items = buckets["category:${category.id}"].orEmpty()
            if (items.isEmpty() && !keepEmpty) continue
            groups += ChatGroup.Category(category, items)
        }
        val byChannel = conversations.groupBy { it.channel }
        val channels = (buckets.keys.filter { it.startsWith("channel:") }.map { it.removePrefix("channel:") } + byChannel.keys)
            .distinct().sortedWith(compareBy<String> { rank(it) }.thenBy { it })
        for (channel in channels) {
            groups += ChatGroup.Channel(
                channel, buckets["channel:$channel"].orEmpty(),
                byChannel[channel].orEmpty().sortedByDescending { it.lastMessageAt },
            )
        }
        groups += ChatGroup.Rest(buckets["rest"].orEmpty())
        return groups
    }

    /** Categories by profile, then their own position. */
    fun ordered(categories: List<SessionCategory>): List<SessionCategory> =
        categories.sortedWith(compareBy<SessionCategory> { it.profile }.thenBy { it.position }.thenBy { it.name })

    /** Categories a chat of [profile] may move into (decision §60: never another profile's). */
    fun movable(categories: List<SessionCategory>, profile: String): List<SessionCategory> =
        ordered(categories).filter { it.profile == profile }

    /** The last position in a category's own profile, for «Move down». */
    fun lastPosition(categories: List<SessionCategory>, category: SessionCategory): Int =
        categories.count { it.profile == category.profile } - 1

    /** The move that files a chat under [categoryId] (null: out of any category), or null when it is already there. */
    fun move(session: Session, categoryId: String?): SessionPatch? {
        if (session.categoryId == categoryId) return null
        return if (categoryId == null) SessionPatch(sendNull = setOf(SessionPatch.Clearable.CATEGORY_ID))
        else SessionPatch(categoryId = categoryId)
    }

    /** The chats list's filter over a conversation: its title, the other party, and its preview. */
    fun matches(conversation: ChannelConversation, query: String): Boolean {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return true
        return listOf(conversation.title, conversation.peerName, conversation.peerId, conversation.lastMessage?.text, conversation.preview)
            .any { (it ?: "").lowercase().contains(needle) }
    }

    /** What a row is called: the other party, as a messaging app names a chat, else Hermes's title or the party's id. */
    fun title(conversation: ChannelConversation): String? = conversation.peerName ?: conversation.title ?: conversation.peerId

    /** The line under the title: the latest message when known (the agent's marked), else Hermes's preview. */
    fun preview(conversation: ChannelConversation, assistant: String): String {
        val last = conversation.lastMessage ?: return conversation.preview.orEmpty()
        return if (last.role == ChannelMessagePreview.Role.ASSISTANT) "$assistant: ${last.text}" else last.text
    }

    /** What the list shows: hidden ones only when asked, none in the archive, the typed filter applied. */
    fun visible(conversations: List<ChannelConversation>, showHidden: Boolean, archive: ArchiveFilter, query: String): List<ChannelConversation> =
        if (archive == ArchiveFilter.ARCHIVED) emptyList()
        else conversations.filter { (showHidden || it.hidden != true) && matches(it, query) }

    fun hiddenCount(conversations: List<ChannelConversation>, archive: ArchiveFilter): Int =
        if (archive == ArchiveFilter.ARCHIVED) 0 else conversations.count { it.hidden == true }

    /** Hermes could not be read: the list says so, and keeps what it read last. */
    fun unreachable(unavailable: List<ChannelConversationsUnavailable>): Boolean =
        unavailable.any { it.reason == ChannelConversationsUnavailable.Reason.HERMES_UNREACHABLE }

    /** The agent a continuation goes to: the profile's Hermes (the one the channel talked to), else the first that can answer. */
    fun continueAgent(agents: List<hub.core.client.model.Agent>): hub.core.client.model.Agent? {
        val ready = agents.filter { it.enabled && it.status in setOf(hub.core.client.model.AgentStatus.AVAILABLE, hub.core.client.model.AgentStatus.LIMITED) }
        return ready.firstOrNull { it.slug == "hermes" } ?: ready.firstOrNull()
    }
}

/** The calls behind categories and channel conversations, each in the profile it acts in. */
class ChatGroupsOps(private val apis: () -> HubApis?) {
    private fun api(): HubApis = apis() ?: throw HubError(0, "offline", null)

    suspend fun categories(profile: String, all: Boolean): Result<List<SessionCategory>> = hubCall {
        api().sessions.sessionsListCategories(profile, if (all) SessionsApi.ProfilesSessionsListCategories.ALL else null).items
    }

    suspend fun createCategory(profile: String, name: String): Result<SessionCategory> =
        hubCall { api().sessions.sessionsCreateCategory(profile, SessionCategoryInput(name = name)) }

    suspend fun updateCategory(category: SessionCategory, input: SessionCategoryInput): Result<SessionCategory> =
        hubCall { api().sessions.sessionsUpdateCategory(category.profile, category.id, input) }

    suspend fun deleteCategory(category: SessionCategory): Result<Unit> =
        hubCall { api().sessions.sessionsDeleteCategory(category.profile, category.id) }

    suspend fun conversations(profile: String, all: Boolean, limit: Int): Result<hub.core.client.model.SessionsListChannelConversations200Response> = hubCall {
        api().sessions.sessionsListChannelConversations(
            profile,
            profiles = if (all) SessionsApi.ProfilesSessionsListChannelConversations.ALL else null,
            hidden = SessionsApi.HiddenSessionsListChannelConversations.INCLUDE,
            limit = limit,
        )
    }

    suspend fun messages(profile: String, id: String, offset: Int? = null): Result<SessionsListChannelMessages200Response> =
        hubCall { api().sessions.sessionsListChannelMessages(profile, id, offset ?: 0) }

    suspend fun hide(conversation: ChannelConversation): Result<Unit> = hubCall { api().sessions.sessionsHideChannelConversation(conversation.profile, conversation.id) }
    suspend fun unhide(conversation: ChannelConversation): Result<Unit> = hubCall { api().sessions.sessionsUnhideChannelConversation(conversation.profile, conversation.id) }
    suspend fun delete(conversation: ChannelConversation): Result<Unit> = hubCall { api().sessions.sessionsDeleteChannelConversation(conversation.profile, conversation.id) }

    /** Writes into a Telegram or WhatsApp conversation from the hub (§153): on the channel first, then to the agent. */
    suspend fun send(profile: String, conversationId: String, text: String, clientId: String): Result<hub.core.client.model.ChannelOutgoing> = hubCall {
        api().sessions.sessionsSendChannelMessage(
            profile, conversationId, hub.core.client.model.ChannelSendRequest(text = text, clientMessageId = clientId),
        ).outgoing
    }

    suspend fun picture(profile: String, conversationId: String, pictureId: String): Result<java.io.File> =
        hubCall { api().sessions.sessionsGetChannelPicture(profile, conversationId, pictureId) }

    suspend fun continueIn(profile: String, conversationId: String, agentId: String, note: String): Result<ChannelContinuation> = hubCall {
        val trimmed = note.trim()
        api().sessions.sessionsContinueChannelConversation(
            profile, conversationId,
            if (trimmed.isEmpty()) ChannelContinueRequest(agentId = agentId, sendNull = setOf(ChannelContinueRequest.Clearable.NOTE))
            else ChannelContinueRequest(agentId = agentId, note = trimmed),
        )
    }

    suspend fun move(session: Session, categoryId: String?): Result<Session>? {
        val patch = ChatGroupsRules.move(session, categoryId) ?: return null
        return hubCall { api().sessions.sessionsUpdate(session.profile, session.id, patch) }
    }
}

/** What the drawer's groups need beyond the chats: the categories and the channel conversations. */
data class ChatExtrasState(
    val categories: List<SessionCategory> = emptyList(),
    val conversations: List<ChannelConversation> = emptyList(),
    val unreachable: Boolean = false,
    val channelLimit: Int = ChatGroupsRules.CHANNEL_PAGE,
    val hasMoreConversations: Boolean = false,
    /** The hub announces each channel turn (`channel_conversation.updated`, §153): the polling slows down. */
    val liveUpdates: Boolean = false,
    val showHidden: Boolean = false,
    val collapsed: Set<String> = emptySet(),
    val error: HubError? = null,
)

/** Holds [ChatExtrasState] for the shell, reading it again with the chats and every 45 s while the list is on screen. */
class ChatExtras(private val scope: CoroutineScope, val ops: ChatGroupsOps) {
    private val _state = MutableStateFlow(ChatExtrasState())
    val state: StateFlow<ChatExtrasState> = _state.asStateFlow()
    private var poll: Job? = null
    private var lastScope: Pair<String, Boolean>? = null

    /** Reads the categories and conversations of [profile] (or every profile the person may enter). */
    fun reload(profile: String, all: Boolean) {
        lastScope = profile to all
        scope.launch {
            ops.categories(profile, all).onSuccess { list -> _state.update { it.copy(categories = list) } }
                .onFailure { e -> if ((e as HubError).status != 501) _state.update { it.copy(error = e) } }
        }
        readConversations()
    }

    private fun readConversations() {
        val (profile, all) = lastScope ?: return
        scope.launch {
            ops.conversations(profile, all, _state.value.channelLimit).onSuccess { page ->
                _state.update {
                    it.copy(
                        conversations = if (ChatGroupsRules.unreachable(page.unavailable) && page.items.isEmpty()) it.conversations else page.items,
                        unreachable = ChatGroupsRules.unreachable(page.unavailable), hasMoreConversations = page.hasMore == true,
                        liveUpdates = page.liveUpdates == true,
                    )
                }
            }
        }
    }

    /**
     * While the drawer's list is on screen, the conversations are read again every
     * [ChatGroupsRules.POLL_MS] — or every few minutes while the hub announces each channel turn
     * itself ([ChannelSendRules.listPollMs]).
     */
    fun watch(on: Boolean) {
        poll?.cancel()
        if (!on) return
        poll = scope.launch {
            while (isActive) {
                delay(ChannelSendRules.listPollMs(_state.value.liveUpdates))
                readConversations()
            }
        }
    }

    private var heardJob: Job? = null

    /** A channel conversation changed (`channel_conversation.updated`): the list is read again, once per burst. */
    fun heard(update: ChannelUpdate) {
        if (!ChannelSendRules.settled(update)) return
        heardJob?.cancel()
        heardJob = scope.launch {
            delay(500)
            readConversations()
        }
    }

    fun older() {
        _state.update { it.copy(channelLimit = (it.channelLimit + ChatGroupsRules.CHANNEL_PAGE).coerceAtMost(ChatGroupsRules.CHANNEL_MAX)) }
        readConversations()
    }

    fun toggleHidden() = _state.update { it.copy(showHidden = !it.showHidden) }
    fun toggleCollapsed(key: String) = _state.update { it.copy(collapsed = if (key in it.collapsed) it.collapsed - key else it.collapsed + key) }
    fun dismissError() = _state.update { it.copy(error = null) }

    /** Runs a write, then reads the categories (and, when [chats] says so, the chats) again. */
    fun write(block: suspend (ChatGroupsOps) -> Result<*>?, after: () -> Unit = {}) {
        scope.launch {
            val result = block(ops) ?: return@launch
            result.onFailure { e -> _state.update { it.copy(error = e as HubError) } }
            lastScope?.let { (profile, all) ->
                ops.categories(profile, all).onSuccess { list -> _state.update { it.copy(categories = list) } }
            }
            readConversations()
            after()
        }
    }
}
