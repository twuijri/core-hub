package hub.core.android.rooms

import hub.core.android.nav.AppPaths
import hub.core.android.nav.Navigator
import hub.core.android.nav.Route
import hub.core.android.realtime.Envelope
import hub.core.android.ui.screens.ChatsBatch
import hub.core.android.ui.screens.Exports
import hub.core.android.ui.screens.NewRoom
import hub.core.android.ui.screens.PendingList
import hub.core.android.ui.screens.RoomLinks
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.Agent
import hub.core.client.model.Approval
import hub.core.client.model.BulkResult
import hub.core.client.model.Mention
import hub.core.client.model.Message
import hub.core.client.model.RoomDetail
import hub.core.client.model.SeatStatus
import hub.core.client.model.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Rooms on the phone and the chats list's batch mode, fed the contract's own shapes. */
class RoomsTest {
    private val json = Serializer.kotlinxSerializationJson
    private val room = "01J8QK3ZR2W7M5N4P6T8V9X0RM"
    private val other = "01J8QK3ZR2W7M5N4P6T8V9X0RO"
    private val me = "01J8QK3ZR2W7M5N4P6T8V9X0HM"
    private val friend = "01J8QK3ZR2W7M5N4P6T8V9X0FR"
    private val planner = "01J8QK3ZR2W7M5N4P6T8V9X0ST"
    private val coder = "01J8QK3ZR2W7M5N4P6T8V9X0SU"
    private var seq = 10L

    private fun seat(id: String, name: String, status: String = "idle") = """
        {"id":"$id","room_id":"$room","agent_id":"01J8QK3ZR2W7M5N4P6T8V9X0AG","name":"$name","description":null,
         "avatar":{"kind":"generated","url":null,"seed":"s"},"model":null,"provider":null,"reasoning_effort":null,
         "instructions":null,"preset_id":null,"status":"$status","executor":{"kind":"server","device_id":null},
         "created_at":"2026-09-21T10:00:00Z","updated_at":"2026-09-21T10:00:00Z"}
    """.trimIndent()

    private fun member(id: String, user: String, name: String, role: String = "member", online: Boolean = true) = """
        {"id":"$id","room_id":"$room","user_id":"$user","name":"$name","avatar":{"kind":"generated","url":null,"seed":"m"},
         "role":"$role","online":$online,"joined_at":"2026-09-21T10:00:00Z"}
    """.trimIndent()

    private fun message(
        id: String, seq: Int, text: String, kind: String = "user", authorId: String? = me, name: String = "طارق",
        roomId: String = room, status: String = "complete", run: String? = null,
    ) = """
        {"id":"$id","profile":"work","owner_id":"$me","created_at":"2026-09-21T10:15:00Z","updated_at":"2026-09-21T10:15:00Z",
         "session_id":"$roomId","room_id":"$roomId","seat_id":null,"seq":$seq,"role":"${if (kind == "agent") "assistant" else "user"}",
         "author":{"kind":"$kind","id":${authorId?.let { "\"$it\"" } ?: "null"},"name":"$name","avatar":null},
         "content":${if (text.isEmpty()) "[]" else """[{"type":"text","text":"$text"}]"""},"reasoning":null,"tool_calls":[],
         "run_id":${run?.let { "\"$it\"" } ?: "null"},"status":"$status","mentions":[],"handoff":null,"usage":null,"reply_to_message_id":null}
    """.trimIndent()

    private fun approval(id: String, roomId: String?, sessionId: String? = "01J8QK3ZR2W7M5N4P6T8V9X0SS", workflow: String? = null, at: String = "2026-09-21T10:16:00Z", profile: String = "work") = """
        {"id":"$id","profile":"$profile","owner_id":"$me","created_at":"$at","updated_at":"$at","kind":"question","status":"pending",
         "session_id":${sessionId?.let { "\"$it\"" } ?: "null"},"run_id":null,"message_id":null,"room_id":${roomId?.let { "\"$it\"" } ?: "null"},
         "workflow_run_id":${workflow?.let { "\"$it\"" } ?: "null"},"node_id":null,
         "agent":{"id":"01J8QK3ZR2W7M5N4P6T8V9X0AG","name":"Hermes"},"title":"أي لون؟","description":null,"command":null,
         "choices":[],"allow_always":false,"answer_mode":"both","response":null,"expires_at":null}
    """.trimIndent()

    private fun detail(seats: String, members: String, approvals: String = "") = json.decodeFromString(
        RoomDetail.serializer(),
        """{"id":"$room","profile":"work","owner_id":"$me","created_at":"2026-09-21T10:00:00Z","updated_at":"2026-09-21T10:00:00Z",
            "name":"فريق الإطلاق","working_dir":null,"invite_code":"AB12CD34","can_manage":true,"can_mention_all":true,
            "member_count":2,"total_tokens":0,"summary_policy":{"every_turns":20,"model":null,"provider":null},
            "handoff":{"enabled":true,"max_depth":3},"seats":[$seats],"last_active_at":null,"lead_seat_id":"$planner",
            "archived_at":null,"members":[$members],"runs":[],"pending_approvals":[$approvals],"handoff_chains":[],
            "memory":{"summary":null,"status":"idle","summarized_turn_count":0,"error":null,"updated_at":null},"typing":[]}""",
    )

    private fun env(event: String, payload: String) =
        Envelope.parse("""{"event":"$event","namespace":"/rt/rooms","profile":"work","ts":"2026-09-21T10:15:04Z","seq":${++seq},"payload":$payload}""")!!

    private fun opened(): RoomState = RoomReducer.loaded(
        RoomState(),
        detail("${seat(planner, "المخطِّط")},${seat(coder, "Code Reviewer")}", "${member("01J8QK3ZR2W7M5N4P6T8V9X0M1", me, "طارق", "owner")},${member("01J8QK3ZR2W7M5N4P6T8V9X0M2", friend, "سارة")}"),
        listOf(json.decodeFromString(Message.serializer(), message("01J8QK3ZR2W7M5N4P6T8V9X0A1", 1, "مرحبا"))),
    )

    // ---------------------------------------------------------------- mentions

    private val seats = listOf(RoomMentions.Seat(planner, "المخطِّط"), RoomMentions.Seat(coder, "Code Reviewer"), RoomMentions.Seat("01J8QK3ZR2W7M5N4P6T8V9X0SV", "Code"))

    @Test fun `an @ being typed is a mention query, an e-mail is not`() {
        assertEquals(RoomMentions.Query(6, "Co"), RoomMentions.query("hello @Co"))
        assertEquals(RoomMentions.Query(0, ""), RoomMentions.query("@"))
        assertNull(RoomMentions.query("mail me at me@example.com"))
        assertNull(RoomMentions.query("@Code\nnext"))
        assertNull(RoomMentions.query("no mention"))
    }

    @Test fun `suggestions start with what was typed, then contain it`() {
        assertEquals(listOf("Code Reviewer", "Code"), RoomMentions.suggest(seats, "co").map { it.name })
        assertEquals(listOf("Code Reviewer"), RoomMentions.suggest(seats, "view").map { it.name })
        assertEquals(3, RoomMentions.suggest(seats, "").size)
    }

    @Test fun `picking a seat replaces what was typed with its name`() {
        assertEquals("hi @Code Reviewer " to 18, RoomMentions.insert("hi @Co", 3, 6, "Code Reviewer"))
    }

    @Test fun `mentions are whole names, longest first, with @all when allowed`() {
        val found = RoomMentions.mentionsIn("@Code Reviewer and @المخطِّط, not @Codex", seats, allowAll = false)
        assertEquals(listOf(coder, planner), found.map { it.seatId })
        assertTrue(RoomMentions.mentionsIn("@all please", seats, allowAll = false).isEmpty())
        val all = RoomMentions.mentionsIn("@all please, @Code", seats, allowAll = true)
        assertEquals(listOf(Mention.Kind.ALL, Mention.Kind.SEAT), all.map { it.kind })
    }

    // ---------------------------------------------------------------- the room

    @Test fun `a seat's reply streams into its message and ends complete`() {
        val reply = "01J8QK3ZR2W7M5N4P6T8V9X0A2"
        val run = "01J8QK3ZR2W7M5N4P6T8V9X0RN"
        var s = opened()
        s = RoomReducer.apply(s, env("message.created", """{"message":${message(reply, 2, "", "agent", "01J8QK3ZR2W7M5N4P6T8V9X0AG", "المخطِّط", status = "streaming", run = run)}}"""))
        s = RoomReducer.apply(s, env("seat.updated", """{"room_id":"$room","seat":${seat(planner, "المخطِّط", "running")}}"""))
        s = RoomReducer.apply(s, env("message.delta", """{"session_id":"x","message_id":"$reply","run_id":"$run","delta":"نبدأ "}"""))
        s = RoomReducer.apply(s, env("message.delta", """{"session_id":"x","message_id":"$reply","run_id":"$run","delta":"بالواجهة."}"""))
        assertEquals("نبدأ بالواجهة.", s.messages.last().text)
        assertTrue(s.messages.last().streaming)
        assertEquals(listOf(planner), s.busySeats.map { it.id })
        assertEquals(SeatStatus.RUNNING, s.seats.first { it.id == planner }.status)
        val runJson = """{"id":"$run","profile":"work","owner_id":"$me","created_at":"2026-09-21T10:15:00Z","updated_at":"2026-09-21T10:15:00Z",
            "session_id":"x","room_id":"$room","seat_id":"$planner","job_id":"01J8QK3ZR2W7M5N4P6T8V9X0JB","status":"succeeded",
            "queue_position":null,"trigger":{"kind":"user","id":"$me"},"input_message_id":null,"output_message_id":null,"model":null,
            "provider":null,"reasoning_effort":null,"interrupted":false,"error":null,"usage":null,"started_at":null,"finished_at":null}"""
        s = RoomReducer.apply(s, env("run.completed", """{"run":$runJson,"message":${message(reply, 2, "نبدأ بالواجهة.", "agent", "01J8QK3ZR2W7M5N4P6T8V9X0AG", "المخطِّط", run = run)}}"""))
        assertFalse(s.messages.last().streaming)
        assertEquals("نبدأ بالواجهة.", s.messages.last().text)
    }

    @Test fun `another room's events change nothing here`() {
        val s = opened()
        val after = RoomReducer.apply(s, env("message.created", """{"message":${message("01J8QK3ZR2W7M5N4P6T8V9X0B1", 5, "غيرها", roomId = other)}}"""))
        assertEquals(s.messages, after.messages)
        assertEquals(s, RoomReducer.apply(s, env("message.delta", """{"session_id":"x","message_id":"01J8QK3ZR2W7M5N4P6T8V9X0B1","run_id":"r","delta":"x"}""")))
        assertEquals(s, RoomReducer.apply(s, env("seat.updated", """{"room_id":"$other","seat":${seat(planner, "المخطِّط", "running")}}""")))
        assertEquals(s, RoomReducer.apply(s, env("approval.requested", """{"approval":${approval("01J8QK3ZR2W7M5N4P6T8V9X0Q9", other)}}""")))
    }

    @Test fun `what a seat asks here waits in the room until it is answered`() {
        var s = opened()
        s = RoomReducer.apply(s, env("approval.requested", """{"approval":${approval("01J8QK3ZR2W7M5N4P6T8V9X0Q1", room)}}"""))
        assertEquals(listOf("01J8QK3ZR2W7M5N4P6T8V9X0Q1"), s.approvals.keys.toList())
        s = RoomReducer.apply(s, env("approval.resolved", """{"approval":${approval("01J8QK3ZR2W7M5N4P6T8V9X0Q1", room)}}"""))
        assertTrue(s.approvals.isEmpty())
        val withPending = RoomReducer.loaded(RoomState(), detail(seat(planner, "المخطِّط"), member("m", me, "طارق"), approval("01J8QK3ZR2W7M5N4P6T8V9X0Q2", room)), emptyList())
        assertEquals(1, withPending.approvals.size)
    }

    @Test fun `people come and go, and typing shows until it stops`() {
        var s = opened()
        s = RoomReducer.apply(s, env("member.typing", """{"room_id":"$room","member_id":"01J8QK3ZR2W7M5N4P6T8V9X0M2","name":"سارة","typing":true}"""))
        assertEquals(mapOf("01J8QK3ZR2W7M5N4P6T8V9X0M2" to "سارة"), s.typing)
        s = RoomReducer.apply(s, env("member.left", """{"room_id":"$room","member":${member("01J8QK3ZR2W7M5N4P6T8V9X0M2", friend, "سارة")}}"""))
        assertTrue(s.typing.isEmpty())
        assertEquals(listOf(me), s.members.map { it.userId })
    }

    @Test fun `only your own messages are on the right; another person is named on the left`() {
        val mine = hub.core.android.chat.ChatMessage.from(json.decodeFromString(Message.serializer(), message("01J8QK3ZR2W7M5N4P6T8V9X0A1", 1, "أنا")))
        val theirs = hub.core.android.chat.ChatMessage.from(json.decodeFromString(Message.serializer(), message("01J8QK3ZR2W7M5N4P6T8V9X0A2", 2, "أنا سارة", authorId = friend, name = "سارة")))
        val agent = hub.core.android.chat.ChatMessage.from(json.decodeFromString(Message.serializer(), message("01J8QK3ZR2W7M5N4P6T8V9X0A3", 3, "تم", "agent", "01J8QK3ZR2W7M5N4P6T8V9X0AG", "المخطِّط")))
        val turns = RoomTurns.group(listOf(mine, theirs, agent), me)
        assertEquals(listOf(true, false, false), turns.map { it.mine })
        assertEquals(listOf("طارق", "سارة", "المخطِّط"), turns.map { it.turn.authorName })
    }

    // ---------------------------------------------------------------- making and joining

    private fun agent(id: String, name: String) = json.decodeFromString(
        Agent.serializer(),
        """{"id":"$id","profile":"work","owner_id":"$me","created_at":"2026-09-20T10:00:00Z",
           "updated_at":"2026-09-20T10:00:00Z","slug":"a$id","name":"$name","kind":"hermes","vendor":null,
           "avatar":{"kind":"generated","url":null,"seed":"a"},"status":"available","enabled":true,
           "install":{"source":"managed","path":null,"package":null,"command":null,"version":null,"latest_version":null,
             "update_available":false,"pinned_version":null,"newer_than_tested":false,"auto_update":false,
             "auto_update_supported":false,"checked_at":null,"error":null},
           "runtime":{"state":"running","url":null,"error":null},"capabilities":["streaming"],"sections":[],"limited":false,"subagents":"none","default_model":null}""",
    )

    @Test fun `a new room's seats are named after their agents, never twice the same`() {
        val seats = NewRoom.seats(listOf(agent("01J8QK3ZR2W7M5N4P6T8V9X0A1", "Hermes"), agent("01J8QK3ZR2W7M5N4P6T8V9X0A2", "hermes"), agent("01J8QK3ZR2W7M5N4P6T8V9X0A3", "all")))
        assertEquals(listOf("Hermes", "hermes 2", "all 2"), seats.map { it.name })
    }

    @Test fun `a pasted code or link gives the invite code`() {
        assertEquals("AB12CD34", RoomLinks.codeOf("ab12cd34"))
        assertEquals("AB12CD34", RoomLinks.codeOf("https://hub.example/join/AB12CD34"))
        assertEquals("AB12CD34", RoomLinks.codeOf(" https://hub.example/join/AB12CD34/?x=1 "))
        assertNull(RoomLinks.codeOf("https://hub.example/join/"))
        assertEquals("https://hub.example/join/AB12CD34", RoomLinks.join("https://hub.example/", "AB12CD34"))
    }

    @Test fun `a room link opens the room in its profile, and a room is a root like a chat`() {
        val target = AppPaths.resolve("/rooms/$room?profile=work")!!
        assertEquals(Route.Room(room, "work"), AppPaths.route(target, "default"))
        assertEquals(Route.NewChat, AppPaths.route(AppPaths.resolve("/rooms")!!, "default"))
        val nav = Navigator()
        nav.go(Route.Tasks)
        nav.go(Route.Room(room, "work"))
        assertEquals(listOf<Route>(Route.Room(room, "work")), nav.stack.toList())
    }

    // ---------------------------------------------------------------- the pending list

    @Test fun `the pending list is oldest first, and each thing opens where it lives`() {
        val inRoom = json.decodeFromString(Approval.serializer(), approval("01J8QK3ZR2W7M5N4P6T8V9X0Q1", room, at = "2026-09-21T10:17:00Z"))
        val inChat = json.decodeFromString(Approval.serializer(), approval("01J8QK3ZR2W7M5N4P6T8V9X0Q2", null, at = "2026-09-21T10:15:00Z", profile = "home"))
        val step = json.decodeFromString(Approval.serializer(), approval("01J8QK3ZR2W7M5N4P6T8V9X0Q3", null, sessionId = null, workflow = "01J8QK3ZR2W7M5N4P6T8V9X0WR"))
        val merged = PendingList.merge(listOf(listOf(inRoom, step), listOf(inChat, inChat)))
        assertEquals(listOf("01J8QK3ZR2W7M5N4P6T8V9X0Q2", "01J8QK3ZR2W7M5N4P6T8V9X0Q3", "01J8QK3ZR2W7M5N4P6T8V9X0Q1"), merged.map { it.id })
        assertEquals(Route.Room(room, "work"), PendingList.routeOf(inRoom))
        assertEquals(Route.Chat("01J8QK3ZR2W7M5N4P6T8V9X0SS", "home"), PendingList.routeOf(inChat))
        assertEquals(Route.Schedules, PendingList.routeOf(step))
    }

    // ---------------------------------------------------------------- batch mode and export

    private fun session(id: String, profile: String) = json.decodeFromString(
        Session.serializer(),
        """{"id":"$id","profile":"$profile","owner_id":"$me","created_at":"2026-09-20T10:00:00Z","updated_at":"2026-09-20T10:00:00Z",
           "agent_id":"01J8QK3ZR2W7M5N4P6T8V9X0AG","source":"chat","pinned":false,"archived":false,"message_count":0,"status":"idle","notify":false}""",
    )

    @Test fun `a selection is sent per profile, at most a hundred a call`() {
        val work = (1..150).map { session("W" + it.toString().padStart(25, '0'), "work") }
        val home = session("H".padEnd(26, '0'), "home")
        val chosen = (work.map { it.id } + home.id).toSet()
        val groups = ChatsBatch.byProfile(work + home + session("X".padEnd(26, '0'), "work"), chosen)
        assertEquals(listOf("work" to 100, "work" to 50, "home" to 1), groups.map { it.first to it.second.size })
        assertEquals(setOf("a"), ChatsBatch.toggle(emptySet(), "a"))
        assertEquals(emptySet<String>(), ChatsBatch.toggle(setOf("a"), "a"))
    }

    @Test fun `what the hub refused in a batch is said, the rest went through`() {
        val result = json.decodeFromString(
            BulkResult.serializer(),
            """{"results":[{"id":"a","ok":true,"error":null},{"id":"b","ok":false,"error":{"error":"لا يمكن أرشفة جلسة الوكيل العام","code":"state_invalid"}}]}""",
        )
        assertEquals(listOf("لا يمكن أرشفة جلسة الوكيل العام"), ChatsBatch.failures(listOf(result)))
    }

    @Test fun `an export is named after its chat`() {
        assertEquals("خطة الإطلاق.md", Exports.fileName("خطة الإطلاق", "01J8QK3ZR2W7M5N4P6T8V9X0YA"))
        assertEquals("a b.md", Exports.fileName("a/b", "x"))
        assertEquals("01J8QK3ZR2W7M5N4P6T8V9X0YA.md", Exports.fileName("  ", "01J8QK3ZR2W7M5N4P6T8V9X0YA"))
    }
}
