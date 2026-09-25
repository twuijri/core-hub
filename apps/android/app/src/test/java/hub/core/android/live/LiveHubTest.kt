package hub.core.android.live

import hub.core.android.chat.ChatReducer
import hub.core.android.chat.ChatState
import hub.core.android.data.AuthInterceptor
import hub.core.android.data.HubApis
import hub.core.android.data.StoredSession
import hub.core.android.data.StoredUser
import hub.core.android.data.TokenKind
import hub.core.android.data.TokenRefresher
import hub.core.android.memoryStore
import hub.core.android.phone.Updates
import hub.core.android.realtime.Envelope
import hub.core.android.realtime.Realtime
import hub.core.android.ui.screens.ChatAgents
import hub.core.client.api.SchedulesApi
import hub.core.client.api.SessionsApi
import hub.core.client.api.TasksApi
import hub.core.client.model.ContentBlock
import hub.core.client.model.LoginRequest
import hub.core.client.model.MessageRole
import hub.core.client.model.RunCreate
import hub.core.client.model.SessionCreate
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * The app's HTTP and realtime layers against a real hub — opt in with
 * `COREHUB_LIVE_HUB=http://127.0.0.1:8080 COREHUB_LIVE_USER=admin COREHUB_LIVE_PASSWORD=…`
 * (`COREHUB_LIVE_AGENT`, default `direct`);
 * skipped otherwise (CI has no hub). Signs in, lists chats across profiles, starts a chat with
 * the first startable agent, streams one run over `/rt/sessions` and reads it back over HTTP.
 */
class LiveHubTest {
    private val hub = System.getenv("COREHUB_LIVE_HUB")

    @Test fun `sign in, chat and stream against a real hub`() = runBlocking {
        assumeTrue("COREHUB_LIVE_HUB not set", hub != null)
        val plain = OkHttpClient()
        val pair = HubApis(hub!!, plain).auth.authLogin(LoginRequest(System.getenv("COREHUB_LIVE_USER"), System.getenv("COREHUB_LIVE_PASSWORD")))
        val store = memoryStore()
        val user = StoredUser.from(pair.user)
        store.save(
            StoredSession(hub, TokenKind.SESSION, pair.accessToken, pair.refreshToken, System.currentTimeMillis() + pair.expiresIn * 1000L, null, user, user.defaultProfile),
        )
        val authed = plain.newBuilder().addInterceptor(AuthInterceptor(store, TokenRefresher(store, plain) {}, { "ar" }) {}).build()
        val apis = HubApis(hub, authed)
        val profile = user.defaultProfile

        val list = apis.sessions.sessionsList(profile, profiles = SessionsApi.ProfilesSessionsList.ALL)
        println("live: ${list.items.size} chats across profiles")
        // The hub's own `direct` agent by default: it needs no runtime, so the run cannot reach a
        // Hermes that happens to run on the same machine (COREHUB_LIVE_AGENT picks another slug).
        val slug = System.getenv("COREHUB_LIVE_AGENT") ?: "direct"
        val agent = ChatAgents.startable(apis.agents.agentsList(profile).items).first { it.slug == slug }
        println("live: agent ${agent.name} (${agent.status})")
        val session = apis.sessions.sessionsCreate(profile, SessionCreate(agentId = agent.id), UUID.randomUUID().toString())

        val realtime = Realtime(plain)
        realtime.connect(store.current!!)
        val scope = CoroutineScope(Dispatchers.IO)
        val events = mutableListOf<Envelope>()
        val collecting = scope.launch { realtime.events.collect { synchronized(events) { events += it } } }
        withTimeout(15_000) { realtime.connected.first { it } }
        val ack = realtime.subscribe(session.id, 0)
        println("live: subscribe ack $ack")
        assertTrue(ack!!.ok)

        val accepted = apis.sessions.sessionsCreateRun(
            profile, session.id, RunCreate(listOf(ContentBlock(ContentBlock.Type.TEXT, text = "مرحبا"))), UUID.randomUUID().toString(),
        )
        val detail = apis.sessions.sessionsGet(profile, session.id)
        var state = ChatReducer.loaded(ChatState(), detail, apis.sessions.sessionsListMessages(profile, session.id).items, 0)
        withTimeout(60_000) {
            while (true) {
                val batch = synchronized(events) { events.toList().also { events.clear() } }
                batch.forEach { println("live: event ${it.namespace} ${it.event} seq=${it.seq}") }
                batch.forEach { state = ChatReducer.apply(state, it, System.currentTimeMillis()) }
                if (batch.any { it.event in setOf("run.completed", "run.failed", "run.cancelled") && it.payload.toString().contains(accepted.runId) }) break
                kotlinx.coroutines.delay(200)
            }
        }
        println("live: run ended; failure=${state.failure}; messages=${state.messages.map { it.role to it.text.take(60) }}; lastSeq=${state.lastSeq}")
        assertFalse(state.running)
        assertTrue(state.messages.any { it.role == MessageRole.USER && it.text == "مرحبا" })
        assertTrue(state.lastSeq > 0)

        val reread = ChatReducer.loaded(ChatState(), apis.sessions.sessionsGet(profile, session.id), apis.sessions.sessionsListMessages(profile, session.id).items, 0)
        assertEquals(session.id, reread.session!!.id)
        assertNotNull(reread.messages.firstOrNull { it.role == MessageRole.USER })

        apis.sessions.sessionsDelete(profile, session.id)
        collecting.cancel()
        scope.cancel()
        realtime.close()
        apis.auth.authLogout()
    }

    @Test fun `every page the phone reads decodes against a real hub`() = runBlocking {
        assumeTrue("COREHUB_LIVE_HUB not set", hub != null)
        val plain = OkHttpClient()
        val pair = HubApis(hub!!, plain).auth.authLogin(LoginRequest(System.getenv("COREHUB_LIVE_USER"), System.getenv("COREHUB_LIVE_PASSWORD")))
        val bearer = plain.newBuilder().addInterceptor { it.proceed(it.request().newBuilder().header("Authorization", "Bearer ${pair.accessToken}").build()) }.build()
        val apis = HubApis(hub, bearer)
        val profile = pair.user.defaultProfile
        val board = apis.tasks.tasksGetColumns(profiles = TasksApi.ProfilesTasksGetColumns.ALL)
        val schedules = apis.schedules.schedulesList(profiles = SchedulesApi.ProfilesSchedulesList.ALL)
        val notices = apis.notify.notifyListNotices(limit = 20)
        val profiles = apis.auth.authListProfiles()
        val users = apis.auth.authListUsers()
        val tokens = apis.auth.authListAppTokens()
        val meta = apis.meta.metaGet()
        val direct = apis.agents.agentsList(profile).items.first { it.slug == "direct" }
        val settings = apis.agents.agentsGetSettings(profile, direct.id)
        val update = Updates.check(apis)
        println("live: update check available=${update.available} reason=${update.reason}")
        val search = apis.sessions.sessionsList(profile, profiles = SessionsApi.ProfilesSessionsList.ALL, archived = SessionsApi.ArchivedSessionsList.ALL, q = "مرحبا")
        println(
            "live: board ${board.columns.size} columns; ${schedules.items.size} schedules; ${notices.items.size} notices; " +
                "${profiles.items.size} profiles; ${users.items.size} users; ${tokens.items.size} app tokens; hub ${meta.name} ${meta.contractVersion}; " +
                "direct settings ${settings.sections.size} sections; search ${search.items.size} hits",
        )
        assertTrue(board.columns.isNotEmpty())
        apis.auth.authLogout()
    }
}
