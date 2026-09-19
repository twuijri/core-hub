package us.i3u.hermesstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reported bug: an English phone, Arabic speech, English nonsense in the
 * composer, because dictation always followed the app's display language.
 *
 * These are the rules that replace it — which language a take runs in, where
 * it runs, what the device is allowed to claim about the languages it has, and
 * what happens when the owner asks for detection on a phone that cannot do it.
 * All pure, so none of it needs a device to be trusted.
 */
class SpeechLanguageTest {

    private val detects = DetectionSupport(
        platform = true,
        engineConfirmed = true,
        allowed = listOf("ar-SA", "en-US"),
    )

    // ── the stored preference ────────────────────────────────────────────

    @Test
    fun `a blank preference is follow-the-app and a damaged one degrades to it`() {
        assertEquals(SpeechLanguages.FOLLOW_APP, SpeechLanguages.normalize(null))
        assertEquals(SpeechLanguages.FOLLOW_APP, SpeechLanguages.normalize("   "))
        // Whatever this is, it is not a language, and it must never reach the
        // recognizer as one.
        assertEquals(SpeechLanguages.FOLLOW_APP, SpeechLanguages.normalize("¡not a tag!"))
        assertEquals(SpeechLanguages.FOLLOW_APP, SpeechLanguages.normalize("a"))
    }

    @Test
    fun `automatic is recognised however it was cased and stored`() {
        assertEquals(SpeechLanguages.AUTOMATIC, SpeechLanguages.normalize("auto"))
        assertEquals(SpeechLanguages.AUTOMATIC, SpeechLanguages.normalize(" AUTO "))
        assertNull(SpeechLanguages.specificTag("auto"))
        assertNull(SpeechLanguages.specificTag(""))
    }

    @Test
    fun `tags from any source end up in one shape`() {
        assertEquals("ar-SA", SpeechLanguages.normalizeTag("ar_SA"))
        assertEquals("ar-SA", SpeechLanguages.normalizeTag(" AR-sa "))
        assertEquals("ar", SpeechLanguages.normalizeTag("ar"))
        assertEquals("", SpeechLanguages.normalizeTag(null))
        assertEquals("", SpeechLanguages.normalizeTag("en US"))
        assertEquals("ar-SA", SpeechLanguages.specificTag("ar_SA"))
    }

    // ── where a take runs ────────────────────────────────────────────────

    @Test
    fun `the default still follows the app language, which is what shipped`() {
        val plan = SpeechLanguages.plan(
            inputMode = Store.VOICE_INPUT_DEVICE,
            choice = SpeechLanguages.FOLLOW_APP,
            appLanguageTag = "en-US",
            recognizerAvailable = true,
        )
        assertEquals(SpeechPlan.OnDevice("en-US"), plan)
    }

    @Test
    fun `the owner's own language wins over the phone's, which is the whole bug`() {
        val plan = SpeechLanguages.plan(
            inputMode = Store.VOICE_INPUT_DEVICE,
            choice = "ar-SA",
            appLanguageTag = "en-US",
            recognizerAvailable = true,
        )
        assertEquals(SpeechPlan.OnDevice("ar-SA"), plan)
    }

    @Test
    fun `automatic runs on the device, not through the server`() {
        val plan = SpeechLanguages.plan(
            inputMode = Store.VOICE_INPUT_DEVICE,
            choice = SpeechLanguages.AUTOMATIC,
            appLanguageTag = "en-US",
            recognizerAvailable = true,
            detection = detects,
        )
        // No audio leaves the phone for this: the engine is handed both
        // languages and picks.
        assertEquals(SpeechPlan.Detect(seed = "en-US", allowed = listOf("ar-SA", "en-US")), plan)
    }

    @Test
    fun `a device that cannot detect falls back to a named language, never silently`() {
        val cases = listOf(
            "the platform is older than Android 14" to DetectionSupport(platform = false, engineConfirmed = true, allowed = listOf("ar-SA", "en-US")),
            "the engine would not confirm" to DetectionSupport(platform = true, engineConfirmed = false, allowed = listOf("ar-SA", "en-US")),
            "one language is not a choice" to DetectionSupport(platform = true, engineConfirmed = true, allowed = listOf("en-US")),
        )
        cases.forEach { (why, support) ->
            val plan = SpeechLanguages.plan(
                inputMode = Store.VOICE_INPUT_DEVICE,
                choice = SpeechLanguages.AUTOMATIC,
                appLanguageTag = "en-US",
                recognizerAvailable = true,
                detection = support,
            )
            // The flag is what makes the composer say so out loud.
            assertEquals(why, SpeechPlan.OnDevice("en-US", detectionUnavailable = true), plan)
        }
    }

    @Test
    fun `the server path is deliberate, and it carries the chosen language as a hint`() {
        val plan = SpeechLanguages.plan(
            inputMode = Store.VOICE_INPUT_SERVER,
            choice = "ar-SA",
            appLanguageTag = "en-US",
            recognizerAvailable = true,
            detection = detects,
        )
        assertEquals(SpeechPlan.OnServer("ar"), plan)
    }

    @Test
    fun `automatic on the server path names no language at all`() {
        val plan = SpeechLanguages.plan(
            inputMode = Store.VOICE_INPUT_SERVER,
            choice = SpeechLanguages.AUTOMATIC,
            appLanguageTag = "en-US",
            recognizerAvailable = true,
            detection = detects,
        )
        assertEquals(SpeechPlan.OnServer(null), plan)
    }

    @Test
    fun `a phone with no recognizer at all can only use the server`() {
        val plan = SpeechLanguages.plan(
            inputMode = Store.VOICE_INPUT_DEVICE,
            choice = "ar-SA",
            appLanguageTag = "en-US",
            recognizerAvailable = false,
            detection = detects,
        )
        assertEquals(SpeechPlan.OnServer("ar"), plan)
    }

    @Test
    fun `the seed is the app's language when the engine has it, and its own otherwise`() {
        assertEquals("en-US", SpeechLanguages.seedFor("en-US", listOf("ar-SA", "en-US")))
        // Same language, different region: still the owner's language.
        assertEquals("en-GB", SpeechLanguages.seedFor("en-US", listOf("ar-SA", "en-GB")))
        // The engine cannot serve the app's language; opening in one it has is
        // better than opening in one it will reject.
        assertEquals("ar-SA", SpeechLanguages.seedFor("fr-FR", listOf("ar-SA", "de-DE")))
    }

    @Test
    fun `the server hint is the base subtag, as the app has always sent it`() {
        assertEquals("ar", SpeechLanguages.serverHint("ar-SA"))
        assertEquals("en", SpeechLanguages.serverHint("en"))
        assertNull(SpeechLanguages.serverHint(""))
    }

    // ── what the device is allowed to claim ──────────────────────────────

    @Test
    fun `only languages the device listed become rows`() {
        val options = SpeechLanguages.fromSupported(
            listOf("en_US", "ar-SA", "EN-us", "  ", "nonsense value", "fr-FR"),
        )
        assertEquals(listOf("ar-SA", "en-US", "fr-FR"), options.map { it.tag })
        assertTrue("a device-reported row is confirmed", options.all { it.confirmed })
    }

    @Test
    fun `the engine's preference moves a row up but never invents one`() {
        val reordered = SpeechLanguages.fromSupported(listOf("ar-SA", "en-US", "fr-FR"), preferred = "fr_FR")
        assertEquals(listOf("fr-FR", "ar-SA", "en-US"), reordered.map { it.tag })

        val unsupported = SpeechLanguages.fromSupported(listOf("ar-SA", "en-US"), preferred = "ja-JP")
        assertEquals("a language the device did not list is not added", listOf("ar-SA", "en-US"), unsupported.map { it.tag })
    }

    @Test
    fun `a device that reported nothing gets the curated guess, marked as one`() {
        assertEquals(emptyList<SpeechLanguageOption>(), SpeechLanguages.fromSupported(null))
        val offered = SpeechLanguages.options(supported = emptyList(), choice = SpeechLanguages.FOLLOW_APP)
        assertTrue(offered.isNotEmpty())
        assertTrue("nothing confirmed it, so nothing may claim it is", offered.none { it.confirmed })
        assertTrue("the owner's own language has to be reachable", offered.any { it.tag == "ar-SA" })
    }

    @Test
    fun `a stored choice the device did not list is still shown, and marked unconfirmed`() {
        val supported = SpeechLanguages.fromSupported(listOf("en-US", "fr-FR"))
        val offered = SpeechLanguages.options(supported, choice = "ar-SA")
        assertEquals("ar-SA", offered.first().tag)
        assertFalse(offered.first().confirmed)
        // Dropping it would move the selection somewhere the owner never chose.
        assertEquals(listOf("ar-SA", "en-US", "fr-FR"), offered.map { it.tag })
    }

    @Test
    fun `detection is only offered languages the engine actually reported`() {
        val allowed = SpeechLanguages.detectionCandidates(
            wanted = listOf("ar-SA", "en-US", "ja-JP"),
            supported = listOf("en-GB", "ar-EG"),
        )
        // Regions differ, languages do not: the engine's own variants are used.
        assertEquals(listOf("ar-EG", "en-GB"), allowed)
        assertTrue("a language it never mentioned is never requested", allowed.none { it.startsWith("ja") })
    }

    @Test
    fun `an engine that reported nothing gets the wanted list to accept or refuse`() {
        val allowed = SpeechLanguages.detectionCandidates(
            wanted = listOf("ar_SA", "en-US", "", "junk!"),
            supported = emptyList(),
        )
        assertEquals(listOf("ar-SA", "en-US"), allowed)
    }

    @Test
    fun `the detection list is deduplicated and capped`() {
        val allowed = SpeechLanguages.detectionCandidates(
            wanted = listOf("ar-SA", "ar_SA", "en-US", "fr-FR", "de-DE", "tr-TR", "ru-RU"),
            supported = emptyList(),
            limit = 3,
        )
        assertEquals(listOf("ar-SA", "en-US", "fr-FR"), allowed)
    }

    // ── what the recording sheet may say ─────────────────────────────────

    @Test
    fun `an unconfident guess is not reported as the detected language`() {
        assertEquals("ar-SA", SpeechLanguages.readDetected("ar_SA", confidence = 3))
        assertEquals("ar-SA", SpeechLanguages.readDetected("ar-SA", confidence = 2))
        // The engine itself is unsure; saying nothing beats saying the wrong thing.
        assertNull(SpeechLanguages.readDetected("ar-SA", confidence = 1))
        assertNull(SpeechLanguages.readDetected("ar-SA", confidence = 0))
        assertNull(SpeechLanguages.readDetected(null, confidence = 3))
        assertNull(SpeechLanguages.readDetected("not a tag", confidence = 3))
    }

    // ── naming a language ────────────────────────────────────────────────

    @Test
    fun `a language is named in itself, so its own speakers can find it`() {
        // The region name itself is CLDR's and differs between JDK and Android
        // releases; what must hold is that the name is in the language itself.
        assertTrue(SpeechLanguages.endonym("ar-SA").startsWith("العربية"))
        assertTrue(SpeechLanguages.endonym("fr-FR").startsWith("Français"))
        assertTrue(SpeechLanguages.endonym("en-US").startsWith("English"))
        // A tag with nothing to look up still gets a label rather than an
        // empty row; the platform synthesizes one from the tag itself.
        assertTrue(SpeechLanguages.endonym("zz-ZZ").isNotBlank())
    }

    @Test
    fun `a name dropped into the other script is isolated so punctuation stays put`() {
        val isolated = SpeechLanguages.isolatedEndonym("en-US")
        assertTrue(isolated.startsWith("⁨"))
        assertTrue(isolated.endsWith("⁩"))

        val list = SpeechLanguages.nameList(listOf("ar-SA", "en-US"), "، ")
        assertEquals(2, list.count { it == '⁨' })
        assertEquals(2, list.count { it == '⁩' })
        assertTrue(list.contains("، "))
    }
}
