package us.i3u.hermesstudio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The group room without a socket: what the reducer does with each event and
 * how the transcript folds tool rows under the agent reply that produced them.
 * These are the parts that decide whether a room reads correctly, so they are
 * checked here rather than by opening a room against a live server.
 */
class GroupRoomTest {

    private val room = RoomInfo(
        id = "room-1", name = "Planning", inviteCode = "ABC234", canManage = true, workspace = "/w",
        totalTokens = 0, summaryProfile = "manager", summaryProvider = "", summaryModel = "", summaryApiMode = "",
        summaryEveryTurns = 10, agentHandoffEnabled = false, agentHandoffMaxDepth = 3, agentHandoffUnlimited = false,
        lastActiveAt = null, createdAt = null,
    )

    private fun message(
        id: String,
        sender: String = "ada",
        role: String = "assistant",
        text: String = "",
        runId: String? = null,
        streaming: Boolean = false,
        timestamp: Long = 1,
        tool: String? = null,
    ) = GroupMessage(
        id = id, roomId = "room-1", senderId = sender, senderName = sender, senderType = if (role == "user") "member" else "agent",
        senderAgentType = null, senderAgentProfile = null, senderAvatar = "", content = text, timestamp = timestamp,
        role = role, runId = runId, reasoning = "", streaming = streaming, toolName = tool, toolCallId = tool?.let { "call-$id" },
        toolPreview = null, toolStatus = if (tool == null) null else "done", toolArgs = null, toolResult = null,
        attachments = emptyList(),
    )

    private fun state(vararg messages: GroupMessage) = RoomState(room = room, messages = messages.toList())

    @Test
    fun `a stream replaces its own empty placeholder and keeps the deltas`() {
        var live = state(message("placeholder", streaming = true))
        live = GroupRoomReducer.reduce(live, RoomEvent.StreamStarted(message("reply", streaming = true)))
        live = GroupRoomReducer.reduce(live, RoomEvent.StreamDelta("reply", "Hel"))
        live = GroupRoomReducer.reduce(live, RoomEvent.StreamDelta("reply", "lo"))
        live = GroupRoomReducer.reduce(live, RoomEvent.ReasoningDelta("reply", "thinking"))

        assertEquals(listOf("reply"), live.messages.map { it.id })
        assertEquals("Hello", live.messages.single().content)
        assertEquals("thinking", live.messages.single().reasoning)
        assertTrue(live.messages.single().streaming)

        live = GroupRoomReducer.reduce(live, RoomEvent.StreamEnded("reply"))
        assertFalse(live.messages.single().streaming)
    }

    @Test
    fun `a stream that ends with nothing to show is dropped`() {
        var live = state()
        live = GroupRoomReducer.reduce(live, RoomEvent.StreamStarted(message("empty", streaming = true)))
        live = GroupRoomReducer.reduce(live, RoomEvent.StreamEnded("empty"))
        assertEquals(emptyList<String>(), live.messages.map { it.id })
    }

    @Test
    fun `the persisted row never loses text the server elided`() {
        var live = state(message("reply", text = "Hello", streaming = true, runId = "run-1"))
        live = GroupRoomReducer.reduce(live, RoomEvent.Posted(message("reply", text = "")))
        assertEquals("Hello", live.messages.single().content)
        assertEquals("run-1", live.messages.single().runId)
        assertFalse(live.messages.single().streaming)
    }

    @Test
    fun `older history is prepended without duplicating ids`() {
        var live = state(message("b", timestamp = 2))
        live = GroupRoomReducer.reduce(live, RoomEvent.HistoryLoaded(listOf(message("a", timestamp = 1), message("b", timestamp = 2)), hasMore = true))
        assertEquals(listOf("a", "b"), live.messages.map { it.id })
        assertTrue(live.hasMore)
    }

    @Test
    fun `activity and context status clear themselves when an agent is ready again`() {
        var live = state()
        live = GroupRoomReducer.reduce(live, RoomEvent.Activity(AgentActivity("seat-1", "run-1", "Ada", "hermes", "replying")))
        live = GroupRoomReducer.reduce(live, RoomEvent.ContextStatus("Ada", "compressing"))
        assertEquals(listOf("Ada"), live.busyAgents.map { it.agentName })
        assertEquals(mapOf("Ada" to "compressing"), live.contextStatuses)

        live = GroupRoomReducer.reduce(live, RoomEvent.Activity(AgentActivity("seat-1", "run-1", "Ada", "hermes", "ready")))
        assertEquals(emptyList<AgentActivity>(), live.busyAgents)
        assertEquals(emptyMap<String, String>(), live.contextStatuses)
    }

    @Test
    fun `an interaction is replaced by its own id and removed when resolved`() {
        val approval = RoomInteraction(RequiredAction.Approval, "ap-1", "Ada", "rm -rf", listOf("yes", "no"), true, 1)
        var live = GroupRoomReducer.reduce(state(), RoomEvent.InteractionRequested(approval))
        live = GroupRoomReducer.reduce(live, RoomEvent.InteractionRequested(approval.copy(prompt = "rm -rf /tmp")))
        assertEquals(1, live.interactions.size)
        assertEquals("rm -rf /tmp", live.interactions.single().prompt)

        live = GroupRoomReducer.reduce(live, RoomEvent.InteractionResolved(RequiredAction.Approval, "ap-1"))
        assertEquals(emptyList<RoomInteraction>(), live.interactions)
    }

    @Test
    fun `clearing the room empties the transcript and the queue but keeps the seats`() {
        var live = state(message("a")).copy(
            agents = listOf(agent("seat-1", "Ada")),
            queue = listOf(QueueItem("q1", "m1", "Ada", "later", 0)),
            activities = mapOf("seat-1" to AgentActivity("seat-1", "r", "Ada", "hermes", "replying")),
        )
        live = GroupRoomReducer.reduce(live, RoomEvent.RoomCleared(0L))
        assertEquals(emptyList<GroupMessage>(), live.messages)
        assertEquals(emptyList<QueueItem>(), live.queue)
        assertEquals(emptyMap<String, AgentActivity>(), live.activities)
        assertEquals(listOf("Ada"), live.agents.map { it.name })
    }

    @Test
    fun `being kicked stops the room being live`() {
        val live = GroupRoomReducer.reduce(state().copy(live = true), RoomEvent.Kicked)
        assertTrue(live.kicked)
        assertFalse(live.live)
    }

    @Test
    fun `tool rows fold under the agent reply of the same run`() {
        val live = state(
            message("user-1", sender = "me", role = "user", text = "go", timestamp = 1),
            message("tool-1", role = "tool", runId = "run-1", tool = "Bash", timestamp = 2),
            message("reply-1", runId = "run-1", text = "done", timestamp = 3),
            message("orphan-tool", role = "tool", tool = "Read", timestamp = 4),
        )
        val lines = roomTranscript(live, myUserId = "me", myName = "me")

        assertEquals(listOf("go", "done", ""), lines.map { it.text })
        assertTrue(lines[0].fromUser)
        assertEquals(listOf("Bash"), lines[1].tools.map { it.name })
        assertEquals(listOf("Read"), lines[2].tools.map { it.name })
    }

    @Test
    fun `a run whose agent row never arrived still shows its tools`() {
        val live = state(message("tool-1", role = "tool", runId = "run-9", tool = "Bash", timestamp = 5))
        val lines = roomTranscript(live, myUserId = "me", myName = "me")
        assertEquals(1, lines.size)
        assertEquals(listOf("Bash"), lines.single().tools.map { it.name })
    }

    @Test
    fun `the snapshot envelope reads the room, its seats and its pending work`() {
        val payload = JSONObject(
            """
            {
              "room": {"id":"room-1","name":"Planning","canManage":true,"totalTokens":120,"agentHandoffEnabled":1},
              "agents": [{"id":"seat-1","agentId":"a1","agent":"claude","profile":"manager","name":"Ada"}],
              "members": [{"userId":"u1","name":"Sara","connectionStatus":"online"}],
              "messages": [{"id":"m1","senderId":"u1","senderName":"Sara","role":"user","content":"hi","timestamp":7}],
              "total": 3,
              "executionQueue": [{"id":"q2","position":1,"targetAgentName":"Ada","textSummary":"b"},{"id":"q1","position":0,"targetAgentName":"Ada","textSummary":"a"}],
              "pendingApprovals": [{"approval_id":"ap-1","agentName":"Ada","command":"ls","allow_permanent":true}],
              "pendingClarifies": [{"clarify_id":"cl-1","agentName":"Ada","question":"which one?","choices":["a","b"]}],
              "handoffChains": [{"chainId":"ch-1","status":"stopped","currentDepth":2,"maxDepth":3}],
              "roomSummary": {"summary":"so far","status":"ready","summarizedTurnCount":4}
            }
            """.trimIndent(),
        )
        val snapshot = requireNotNull(GroupJson.snapshot(payload, "room-1"))

        assertEquals("Planning", snapshot.room.name)
        assertTrue(snapshot.room.canManage)
        assertTrue(snapshot.room.agentHandoffEnabled)
        assertEquals(120L, snapshot.room.totalTokens)
        assertEquals(listOf("Ada"), snapshot.agents.map { it.name })
        assertEquals(listOf("Sara"), snapshot.members.map { it.name })
        assertTrue(snapshot.members.single().online)
        assertTrue("one page of three is not all of them", snapshot.hasMore)
        assertEquals(listOf("q1", "q2"), snapshot.executionQueue.map { it.id })
        assertEquals("ap-1", snapshot.pendingApprovals.single().id)
        assertTrue(snapshot.pendingApprovals.single().allowPermanent)
        assertEquals(listOf("a", "b"), snapshot.pendingClarifies.single().choices)
        assertEquals("ch-1", snapshot.handoffs.single().chainId)
        assertEquals("so far", snapshot.summary?.summary)
    }

    @Test
    fun `content blocks become text and named attachments`() {
        val payload = JSONObject("""{"id":"m1","role":"user","content":[{"type":"text","text":"look"},{"type":"file","name":"plan.pdf"}],"mentions":[{"type":"all"}]}""")
        val parsed = requireNotNull(GroupJson.message(payload))
        assertEquals("look\n📎 plan.pdf", parsed.content)
        assertTrue(parsed.mentionsAll)
        assertNull(parsed.runId)
    }

    @Test
    fun `a preset becomes a seat draft that carries its own id`() {
        val preset = AgentPreset(
            id = "p1", name = "Reviewer", description = "reads code", agent = "claude", agentMode = "global",
            profile = "manager", provider = "anthropic", model = "sonnet", apiMode = "responses",
            reasoningEffort = "high", avatar = "", available = true, validationError = "",
        )
        val draft = preset.toDraft()
        assertEquals("p1", draft.presetId)
        assertEquals("claude", draft.agent)

        val body = draft.toJson(forPreset = false)
        assertEquals("p1", body.optString("presetId"))
        // apiMode is only sent for a non-hermes seat that is not global.
        assertFalse(body.has("apiMode"))
        assertFalse("a preset body must not carry a preset id", draft.toJson(forPreset = true).has("presetId"))
    }

    private fun agent(id: String, name: String) = RoomAgent(
        id = id, agentId = id, agent = "hermes", agentMode = "scoped", profile = "manager", provider = "",
        model = "", apiMode = "", reasoningEffort = "", name = name, description = "", avatar = "",
        executorType = "server", connectionStatus = "online",
    )
}
