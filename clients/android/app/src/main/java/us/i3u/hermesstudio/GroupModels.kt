package us.i3u.hermesstudio

import org.json.JSONArray
import org.json.JSONObject

/**
 * Group chat records as the web client's `api/studio/group-chat.ts` types
 * them. Parsing lives here so the socket, the REST layer and the tests all
 * read one shape.
 */

/** `RoomInfo`: what `GET /rooms` and `GET /rooms/{id}` say about a room. */
data class RoomInfo(
    val id: String,
    val name: String,
    val inviteCode: String?,
    val canManage: Boolean,
    val workspace: String,
    val totalTokens: Long,
    val summaryProfile: String,
    val summaryProvider: String,
    val summaryModel: String,
    val summaryApiMode: String,
    val summaryEveryTurns: Int,
    val agentHandoffEnabled: Boolean,
    val agentHandoffMaxDepth: Int?,
    val agentHandoffUnlimited: Boolean,
    val lastActiveAt: Long?,
    val createdAt: Long?,
    /** Avatar-only agent summaries carried by the room list. */
    val agents: List<RoomAgent> = emptyList(),
)

/** `RoomAgent`: one agent seat in a room (a `gc_room_agents` row). */
data class RoomAgent(
    val id: String,
    val agentId: String,
    val agent: String,
    val agentMode: String,
    val profile: String,
    val provider: String,
    val model: String,
    val apiMode: String,
    val reasoningEffort: String,
    val name: String,
    val description: String,
    /** Raw avatar spec JSON, as Studio stores it; blank when generated from the name. */
    val avatar: String,
    val executorType: String,
    val connectionStatus: String,
    val historical: Boolean = false,
)

/** `RoomAgentInput` / `GroupAgentPresetInput`: what the server accepts for an agent seat. */
data class RoomAgentDraft(
    val agent: String = "hermes",
    val agentMode: String = "scoped",
    val profile: String,
    val provider: String = "",
    val model: String = "",
    val apiMode: String = "",
    val reasoningEffort: String = "",
    val name: String = "",
    val description: String = "",
    val avatar: String = "",
    val presetId: String? = null,
) {
    /** The preset body only allows the documented fields; a room agent may also carry `presetId`. */
    fun toJson(forPreset: Boolean): JSONObject = JSONObject().apply {
        put("agent", agent)
        put("agentMode", agentMode)
        put("profile", profile)
        if (provider.isNotBlank()) put("provider", provider)
        if (model.isNotBlank()) put("model", model)
        if (apiMode.isNotBlank() && agent != "hermes" && agentMode != "global") put("apiMode", apiMode)
        put("reasoningEffort", reasoningEffort)
        if (name.isNotBlank() || forPreset) put("name", name)
        if (description.isNotBlank() || forPreset) put("description", description)
        if (avatar.isNotBlank()) put("avatar", avatar)
        if (!forPreset && !presetId.isNullOrBlank()) put("presetId", presetId)
    }
}

/** `GroupAgentPreset`: a saved agent seat the user can drop into any room. */
data class AgentPreset(
    val id: String,
    val name: String,
    val description: String,
    val agent: String,
    val agentMode: String,
    val profile: String,
    val provider: String,
    val model: String,
    val apiMode: String,
    val reasoningEffort: String,
    val avatar: String,
    val available: Boolean,
    val validationError: String,
) {
    fun toDraft(): RoomAgentDraft = RoomAgentDraft(
        agent = agent, agentMode = agentMode, profile = profile, provider = provider, model = model,
        apiMode = apiMode, reasoningEffort = reasoningEffort, name = name, description = description,
        avatar = avatar, presetId = id,
    )
}

/** `MemberInfo`: a human in the room. */
data class RoomMember(
    val id: String,
    val userId: String,
    val name: String,
    val description: String,
    val avatar: String,
    val online: Boolean,
)

/** One attachment on a group message; [url] is relative to the server. */
data class GroupAttachment(val id: String, val name: String, val type: String, val size: Long, val url: String)

/**
 * `ChatMessage` of the group namespace. Tool rows (`role == "tool"`) arrive as
 * their own messages and are folded under their agent's reply by the reducer.
 */
data class GroupMessage(
    val id: String,
    val roomId: String,
    val senderId: String,
    val senderName: String,
    val senderType: String,
    val senderAgentType: String?,
    val senderAgentProfile: String?,
    val senderAvatar: String,
    val content: String,
    val timestamp: Long,
    val role: String,
    val runId: String?,
    val reasoning: String,
    val streaming: Boolean,
    val toolName: String?,
    val toolCallId: String?,
    val toolPreview: String?,
    val toolStatus: String?,
    val toolArgs: String?,
    val toolResult: String?,
    val attachments: List<GroupAttachment>,
    val mentionsAll: Boolean = false,
) {
    val isAgent: Boolean get() = senderType == "agent" || role == "assistant"
    val isTool: Boolean get() = role == "tool"
}

/** `GroupAgentActivity`: what an agent is doing right now. */
data class AgentActivity(val agentId: String, val runId: String, val agentName: String, val agent: String, val status: String)

/** `GroupExecutionQueueItem`: a message waiting for an agent that is busy. */
data class QueueItem(val id: String, val messageId: String, val targetAgentName: String, val textSummary: String, val position: Int)

/** A pending approval or clarification raised by an agent in the room. */
data class RoomInteraction(
    val kind: RequiredAction,
    val id: String,
    val agentName: String,
    val prompt: String,
    val choices: List<String>,
    val allowPermanent: Boolean,
    val requestedAt: Long,
)

/** `RoomSummaryState`. */
data class RoomSummary(
    val summary: String,
    val status: String,
    val summarizedTurnCount: Int,
    val updatedAt: Long,
    val lastError: String?,
)

/** `RoomAgentHandoffChain`. */
data class HandoffChain(
    val chainId: String,
    val roomId: String,
    val targetAgentId: String,
    val status: String,
    val stopReason: String,
    val currentDepth: Int,
    val maxDepth: Int?,
    val unlimited: Boolean,
    val continueUsed: Boolean,
    val lastError: String?,
    val updatedAt: Long,
)

/** Everything `GET /rooms/{id}` (and the socket `join` ack) hands back. */
data class RoomSnapshot(
    val room: RoomInfo,
    val messages: List<GroupMessage>,
    val agents: List<RoomAgent>,
    val members: List<RoomMember>,
    val handoffs: List<HandoffChain>,
    val hasMore: Boolean,
    val total: Int,
    val executionQueue: List<QueueItem> = emptyList(),
    val pendingApprovals: List<RoomInteraction> = emptyList(),
    val pendingClarifies: List<RoomInteraction> = emptyList(),
    val activities: List<AgentActivity> = emptyList(),
    val summary: RoomSummary? = null,
)

/** JSON → model helpers shared by the REST client and the socket. */
object GroupJson {
    fun room(item: JSONObject): RoomInfo? {
        val id = item.optString("id").ifBlank { item.optString("roomId") }.takeIf { it.isNotBlank() } ?: return null
        val handoffDepth = item.opt("agentHandoffMaxDepth")
        return RoomInfo(
            id = id,
            name = item.optString("name").ifBlank { id.take(8) },
            inviteCode = item.optString("inviteCode").takeIf { it.isNotBlank() && it != "null" },
            canManage = item.optBoolean("canManage", false),
            workspace = item.optString("workspace"),
            totalTokens = item.optLong("totalTokens", 0L),
            summaryProfile = item.optString("summaryProfile"),
            summaryProvider = item.optString("summaryProvider"),
            summaryModel = item.optString("summaryModel"),
            summaryApiMode = item.optString("summaryApiMode"),
            summaryEveryTurns = item.optInt("summaryEveryTurns", 0),
            agentHandoffEnabled = truthy(item.opt("agentHandoffEnabled")),
            agentHandoffMaxDepth = (handoffDepth as? Number)?.toInt(),
            agentHandoffUnlimited = truthy(item.opt("agentHandoffUnlimited")),
            lastActiveAt = item.optLong("lastActiveAt", 0L).takeIf { it > 0 },
            createdAt = item.optLong("createdAt", 0L).takeIf { it > 0 },
            agents = agents(item.optJSONArray("agents")),
        )
    }

    fun agents(array: JSONArray?): List<RoomAgent> = objects(array).mapNotNull(::agent)

    fun agent(item: JSONObject): RoomAgent? {
        val id = item.optString("id").takeIf { it.isNotBlank() } ?: item.optString("agentId").takeIf { it.isNotBlank() } ?: return null
        return RoomAgent(
            id = id,
            agentId = item.optString("agentId").ifBlank { id },
            agent = item.optString("agent").ifBlank { "hermes" },
            agentMode = item.optString("agentMode").ifBlank { "scoped" },
            profile = item.optString("profile"),
            provider = item.optString("provider"),
            model = item.optString("model"),
            apiMode = item.optString("apiMode"),
            reasoningEffort = item.optString("reasoningEffort"),
            name = item.optString("name").ifBlank { item.optString("profile") }.ifBlank { id },
            description = item.optString("description"),
            avatar = item.optString("avatar").takeIf { it != "null" }.orEmpty(),
            executorType = item.optString("executorType").ifBlank { "server" },
            connectionStatus = item.optString("connectionStatus").ifBlank { "online" },
            historical = item.optBoolean("historical", false),
        )
    }

    fun members(array: JSONArray?): List<RoomMember> = objects(array).mapNotNull { item ->
        val userId = item.optString("userId").ifBlank { item.optString("id") }.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        RoomMember(
            id = item.optString("id").ifBlank { userId },
            userId = userId,
            name = item.optString("name").ifBlank { userId },
            description = item.optString("description"),
            avatar = item.optString("avatar").takeIf { it != "null" }.orEmpty(),
            online = item.optString("connectionStatus").ifBlank { "online" } == "online",
        )
    }

    fun preset(item: JSONObject): AgentPreset? {
        val id = item.optString("id").takeIf { it.isNotBlank() } ?: return null
        return AgentPreset(
            id = id,
            name = item.optString("name").ifBlank { id },
            description = item.optString("description"),
            agent = item.optString("agent").ifBlank { "hermes" },
            agentMode = item.optString("agentMode").ifBlank { "scoped" },
            profile = item.optString("profile"),
            provider = item.optString("provider"),
            model = item.optString("model"),
            apiMode = item.optString("apiMode"),
            reasoningEffort = item.optString("reasoningEffort"),
            avatar = item.optString("avatar").takeIf { it != "null" }.orEmpty(),
            available = item.optBoolean("available", true),
            validationError = item.optString("validationError"),
        )
    }

    fun message(item: JSONObject): GroupMessage? {
        val id = item.optString("id").takeIf { it.isNotBlank() } ?: return null
        val content = when (val raw = item.opt("content")) {
            is JSONArray -> blocksToText(raw)
            is String -> if (raw.startsWith("[")) runCatching { blocksToText(JSONArray(raw)) }.getOrDefault(raw) else raw
            null -> ""
            else -> raw.toString()
        }
        val toolArgs = item.opt("toolArgs")?.let { if (it is JSONObject || it is JSONArray) prettyJson(it) else it.toString().takeIf { text -> text != "null" } }
        val toolResult = item.opt("toolResult")?.let { if (it is JSONObject || it is JSONArray) prettyJson(it) else it.toString().takeIf { text -> text != "null" } }
        val mentions = item.optJSONArray("mentions")
        return GroupMessage(
            id = id,
            roomId = item.optString("roomId"),
            senderId = item.optString("senderId"),
            senderName = item.optString("senderName").ifBlank { item.optString("senderId") },
            senderType = item.optString("senderType").ifBlank { if (item.optString("role") == "assistant" || item.optString("role") == "tool") "agent" else "member" },
            senderAgentType = item.optString("senderAgentType").takeIf { it.isNotBlank() },
            senderAgentProfile = item.optString("senderAgentProfile").takeIf { it.isNotBlank() },
            senderAvatar = item.optString("senderAvatar").takeIf { it != "null" }.orEmpty(),
            content = content,
            timestamp = item.optLong("timestamp", 0L),
            role = item.optString("role").ifBlank { "user" },
            runId = item.optString("run_id").takeIf { it.isNotBlank() && it != "null" },
            reasoning = item.optString("reasoning").takeIf { it != "null" }.orEmpty().ifBlank { item.optString("reasoning_content").takeIf { it != "null" }.orEmpty() },
            streaming = item.optBoolean("isStreaming", false) || item.optString("finish_reason") == "streaming",
            toolName = item.optString("toolName").ifBlank { item.optString("tool_name") }.takeIf { it.isNotBlank() && it != "null" },
            toolCallId = item.optString("toolCallId").ifBlank { item.optString("tool_call_id") }.takeIf { it.isNotBlank() && it != "null" },
            toolPreview = item.optString("toolPreview").takeIf { it.isNotBlank() },
            toolStatus = item.optString("toolStatus").takeIf { it.isNotBlank() },
            toolArgs = toolArgs,
            toolResult = toolResult,
            attachments = objects(item.optJSONArray("attachments")).mapNotNull { file ->
                val name = file.optString("name").takeIf { it.isNotBlank() } ?: return@mapNotNull null
                GroupAttachment(file.optString("id").ifBlank { name }, name, file.optString("type"), file.optLong("size", 0L), file.optString("url"))
            },
            mentionsAll = objects(mentions).any { it.optString("type") == "all" },
        )
    }

    fun messages(array: JSONArray?): List<GroupMessage> = objects(array).mapNotNull(::message)

    fun activity(item: JSONObject): AgentActivity? {
        val agentId = item.optString("agentId").takeIf { it.isNotBlank() } ?: return null
        return AgentActivity(agentId, item.optString("runId"), item.optString("agentName").ifBlank { agentId }, item.optString("agent"), item.optString("status").ifBlank { "ready" })
    }

    fun queue(array: JSONArray?): List<QueueItem> = objects(array).mapNotNull { item ->
        val id = item.optString("id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
        QueueItem(id, item.optString("messageId"), item.optString("targetAgentName"), item.optString("textSummary"), item.optInt("position", 0))
    }.sortedBy { it.position }

    fun approval(item: JSONObject): RoomInteraction? {
        val id = item.optString("approval_id").ifBlank { item.optString("approvalId") }.takeIf { it.isNotBlank() } ?: return null
        val prompt = listOf(item.optString("command"), item.optString("description")).filter { it.isNotBlank() }.joinToString("\n")
        return RoomInteraction(
            kind = RequiredAction.Approval,
            id = id,
            agentName = item.optString("agentName"),
            prompt = prompt,
            choices = strings(item.optJSONArray("choices")),
            allowPermanent = item.optBoolean("allow_permanent", item.optBoolean("allowPermanent", false)),
            requestedAt = item.optLong("requested_at", item.optLong("requestedAt", 0L)),
        )
    }

    fun clarify(item: JSONObject): RoomInteraction? {
        val id = item.optString("clarify_id").ifBlank { item.optString("clarifyId") }.takeIf { it.isNotBlank() } ?: return null
        return RoomInteraction(
            kind = RequiredAction.Clarification,
            id = id,
            agentName = item.optString("agentName"),
            prompt = item.optString("question"),
            choices = strings(item.optJSONArray("choices")),
            allowPermanent = false,
            requestedAt = item.optLong("requested_at", item.optLong("requestedAt", 0L)),
        )
    }

    fun summary(item: JSONObject?): RoomSummary? {
        item ?: return null
        return RoomSummary(
            summary = item.optString("summary"),
            status = item.optString("status").ifBlank { "idle" },
            summarizedTurnCount = item.optInt("summarizedTurnCount", 0),
            updatedAt = item.optLong("updatedAt", 0L),
            lastError = item.optString("lastError").takeIf { it.isNotBlank() && it != "null" },
        )
    }

    fun handoff(item: JSONObject): HandoffChain? {
        val id = item.optString("chainId").takeIf { it.isNotBlank() } ?: return null
        return HandoffChain(
            chainId = id,
            roomId = item.optString("roomId"),
            targetAgentId = item.optString("targetAgentId"),
            status = item.optString("status").ifBlank { "stopped" },
            stopReason = item.optString("stopReason"),
            currentDepth = item.optInt("currentDepth", 0),
            maxDepth = (item.opt("maxDepth") as? Number)?.toInt(),
            unlimited = truthy(item.opt("unlimited")),
            continueUsed = truthy(item.opt("continueUsed")),
            lastError = item.optString("lastError").takeIf { it.isNotBlank() && it != "null" },
            updatedAt = item.optLong("updatedAt", 0L),
        )
    }

    fun handoffs(array: JSONArray?): List<HandoffChain> = objects(array).mapNotNull(::handoff)

    /** `GET /rooms/{id}` and the `join` ack share this envelope. */
    fun snapshot(root: JSONObject, fallbackRoomId: String): RoomSnapshot? {
        val room = root.optJSONObject("room")?.let(::room)
            ?: RoomInfo(
                id = root.optString("roomId").ifBlank { fallbackRoomId },
                name = root.optString("roomName").ifBlank { fallbackRoomId },
                inviteCode = null, canManage = false, workspace = "", totalTokens = 0L,
                summaryProfile = "", summaryProvider = "", summaryModel = "", summaryApiMode = "", summaryEveryTurns = 0,
                agentHandoffEnabled = false, agentHandoffMaxDepth = null, agentHandoffUnlimited = false, lastActiveAt = null, createdAt = null,
            )
        val messages = messages(root.optJSONArray("messages"))
        val total = root.optInt("total", messages.size)
        return RoomSnapshot(
            room = room,
            messages = messages,
            agents = agents(root.optJSONArray("agents")),
            members = members(root.optJSONArray("members")),
            handoffs = handoffs(root.optJSONArray("handoffChains")),
            hasMore = root.optBoolean("hasMore", messages.size < total),
            total = total,
            executionQueue = queue(root.optJSONArray("executionQueue")),
            pendingApprovals = objects(root.optJSONArray("pendingApprovals")).mapNotNull(::approval),
            pendingClarifies = objects(root.optJSONArray("pendingClarifies")).mapNotNull(::clarify),
            activities = objects(root.optJSONArray("activities")).mapNotNull(::activity),
            summary = summary(root.optJSONObject("roomSummary")),
        )
    }

    /** Text of a content-block array: text blocks joined, files named. */
    fun blocksToText(blocks: JSONArray): String = objects(blocks).joinToString("\n") { block ->
        when (block.optString("type")) {
            "text" -> block.optString("text")
            "image", "file" -> block.optString("name").takeIf { it.isNotBlank() }?.let { "📎 $it" }.orEmpty()
            else -> ""
        }
    }.trim()

    private fun prettyJson(value: Any): String = when (value) {
        is JSONObject -> value.toString(2)
        is JSONArray -> value.toString(2)
        else -> value.toString()
    }

    private fun truthy(value: Any?): Boolean = when (value) {
        is Boolean -> value
        is Number -> value.toInt() != 0
        is String -> value == "1" || value.equals("true", ignoreCase = true)
        else -> false
    }

    private fun strings(array: JSONArray?): List<String> = array?.let { (0 until it.length()).map { i -> it.optString(i) }.filter(String::isNotBlank) }.orEmpty()

    private fun objects(array: JSONArray?): List<JSONObject> = array?.let { (0 until it.length()).mapNotNull { i -> it.optJSONObject(i) } }.orEmpty()
}
