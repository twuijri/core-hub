package us.i3u.hermesstudio

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The profile-consistency rule behind the second reported issue.
 *
 * The owner heard his Grok Arabic voice on iOS and an OpenAI voice on Android
 * for the same question. Both clients used to send no provider, so the server
 * resolved one per profile — which means the two phones were resolving
 * *different profiles*, or the server had different things stored for them.
 * The fix already on this branch sends the provider explicitly; what it needs
 * is a guarantee that the provider it sends belongs to the profile the
 * conversation actually ran under.
 *
 * So the rule is one function, [ProfileScope.of], and these tests hold both
 * halves: the rule itself, and the fact that nothing in the voice path works
 * it out privately any more.
 */
class ProfileScopeTest {

    // ── the rule ─────────────────────────────────────────────────────────

    @Test
    fun `the open conversation's own profile wins over the drawer's`() {
        // A conversation belongs to the profile it was created under and keeps
        // it when the drawer moves elsewhere; the voice has to follow the
        // conversation, not the drawer.
        assertEquals("manager", ProfileScope.of("manager", "barq"))
    }

    @Test
    fun `a conversation with no profile falls back to the active one`() {
        assertEquals("barq", ProfileScope.of(null, "barq"))
        assertEquals("barq", ProfileScope.of("", "barq"))
        assertEquals("barq", ProfileScope.of("   ", "barq"))
    }

    @Test
    fun `with nothing at all the name is the server's own default`() {
        assertEquals(ProfileScope.DEFAULT, ProfileScope.of(null, null))
        assertEquals(ProfileScope.DEFAULT, ProfileScope.of("", ""))
        assertEquals("default", ProfileScope.DEFAULT)
    }

    @Test
    fun `a blank session profile no longer skips the active profile`() {
        // The conversation screen used to write `openSession?.profile ?:
        // activeProfile` and then `.ifBlank { "default" }`, so a session row
        // carrying an empty profile string jumped straight past `barq` to
        // `default` — and asked Core Hub for the wrong profile's voice.
        assertEquals("barq", ProfileScope.of("", "barq"))
    }

    // ── nothing resolves a profile privately any more ────────────────────

    private val sources = File("src/main/java/us/i3u/hermesstudio")
        .walkTopDown()
        .filter { it.extension == "kt" }
        .toList()

    private fun source(name: String): String =
        sources.first { it.name == name }.readText()

    /**
     * The exact expression that used to be copied around. Any new copy is a
     * new chance for the spoken reply and the Voice section to disagree, which
     * is the shape of the bug this file exists for.
     */
    @Test
    fun `the session-or-active expression is written once, in ProfileScope`() {
        val duplicated = Regex("""\?\.profile\?\.ifBlank \{ null \}\s*\n?\s*\?: .*activeProfile""")
        val offenders = sources
            .filter { it.name != "ProfileScope.kt" }
            .filter { duplicated.containsMatchIn(it.readText()) }
            .map { it.name }
        assertEquals(
            "resolve the profile through ProfileScope.of instead of repeating the rule",
            emptyList<String>(),
            offenders,
        )
    }

    @Test
    fun `currentProfile and the chat run both go through the one rule`() {
        val viewModel = source("AppViewModel.kt")
        assertTrue(
            "UiState.chatProfile must be the rule, not another copy of it",
            viewModel.contains("val UiState.chatProfile: String get() = ProfileScope.of(openSession?.profile, activeProfile)"),
        )
        assertTrue(
            "currentProfile() must read chatProfile",
            viewModel.contains("private fun currentProfile(): String = _state.value.chatProfile"),
        )
        assertTrue(
            "the chat run must resolve its profile the same way",
            viewModel.contains("val profile = ProfileScope.of(session?.profile, _state.value.activeProfile)"),
        )
    }

    /**
     * Every voice call is per profile on the server: `GET /api/studio/tts/settings`,
     * `PUT /api/studio/tts/settings/active`, `POST /api/studio/tts/synthesize`
     * and the STT preflight all key off `X-Hermes-Profile`. Each of them has to
     * take its profile from the one rule.
     */
    @Test
    fun `every voice call in the view model is scoped by the one rule`() {
        val viewModel = source("AppViewModel.kt")
        val scoped = Regex("""^\s*(?:val profile = currentProfile\(\)|val profile = ProfileScope\.of)""", RegexOption.MULTILINE)
        listOf("loadVoiceSettings", "setVoiceOutput", "setSpeechLanguage").forEach { name ->
            val body = viewModel.substringAfter("fun $name").substringBefore("\n    }")
            assertTrue(
                "$name must scope itself with currentProfile()",
                scoped.containsMatchIn(body),
            )
        }
        // speakText is handed the profile by its caller; both callers are the
        // chat run's own `profile`, which is ProfileScope's output.
        assertTrue(
            "a reply is spoken with the profile its own run used",
            viewModel.contains("speakText(finalReply, key, profile)"),
        )
    }

    @Test
    fun `the conversation screen speaks with the conversation's profile`() {
        val screen = source("ConversationScreen.kt")
        assertTrue(
            "the speak button must use chatProfile, not its own expression",
            screen.contains("val profileName = state.chatProfile"),
        )
        assertTrue(
            "and hand that same name to toggleSpeech",
            screen.contains("viewModel.toggleSpeech(line, profileName)"),
        )
    }

    /**
     * The Voice section is read per profile and re-read when the profile
     * changes. Keying that on `activeProfile` alone was wrong: opening another
     * profile's conversation changes which profile the chat runs under without
     * touching the drawer's active profile at all, and the section would go on
     * listing the previous profile's providers.
     */
    @Test
    fun `the voice settings are re-read when the chat's profile changes`() {
        val settings = source("MainActivity.kt")
        assertTrue(
            "the reload has to follow chatProfile, not activeProfile",
            settings.contains("LaunchedEffect(state.chatProfile) {"),
        )
        assertTrue(settings.contains("viewModel.loadVoiceSettings()"))
    }

    /**
     * The picked voice is stored per profile, so switching profile and coming
     * back must return the same provider rather than the other profile's.
     */
    @Test
    fun `the picked provider is stored per profile, so a switch cannot lose it`() {
        val store = source("Store.kt")
        assertTrue(
            "the key has to carry the profile",
            store.contains("""prefs.getString("${'$'}KEY_VOICE_OUTPUT_PREFIX${'$'}{profile.ifBlank { "default" }}", "")"""),
        )
        val viewModel = source("AppViewModel.kt")
        assertTrue(
            "and the cache of the server's providers has to be keyed the same way",
            viewModel.contains("voiceSettingsCache.getOrPut(profile)"),
        )
        assertTrue(
            "the speak path reads the choice for the profile it is speaking for",
            viewModel.contains("val choice = store.voiceOutput(profile)"),
        )
    }
}
