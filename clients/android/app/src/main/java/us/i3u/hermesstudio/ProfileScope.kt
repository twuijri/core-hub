package us.i3u.hermesstudio

/**
 * Which Hermes profile the chat screen is acting under.
 *
 * Core Hub stores voice settings — the TTS providers, the active one, the STT
 * provider — per profile, and every call carries the profile in the
 * `X-Hermes-Profile` header. So a spoken reply is only right when the profile
 * that synthesized it is the profile the conversation ran under, and the Voice
 * section is only honest when it lists that same profile's providers.
 *
 * The rule was written out four separate times in [AppViewModel] and once more
 * in the conversation screen. Four copies of a rule are four chances for one
 * of them to drift, which is exactly the shape of the reported bug: two
 * devices speaking with different voices because they were resolving different
 * profiles. It is one function now, and [ProfileScopeTest] holds it.
 */
object ProfileScope {

    /** The name used when nothing has been chosen, matching the server's own. */
    const val DEFAULT = "default"

    /**
     * The open conversation's own profile wins, because a conversation belongs
     * to the profile it was created under and keeps it when the drawer's
     * active profile moves elsewhere. A blank or absent one falls back to the
     * active profile, and a blank active profile to [DEFAULT].
     */
    fun of(sessionProfile: String?, activeProfile: String?): String =
        sessionProfile?.ifBlank { null }
            ?: activeProfile?.ifBlank { null }
            ?: DEFAULT
}
