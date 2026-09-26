package hub.core.android.shots

import hub.core.android.AppGraph
import hub.core.android.CoreHubApp
import hub.core.android.ReversingSealer
import hub.core.android.phone.AppRelease
import hub.core.android.phone.Lookup
import hub.core.android.phone.ReleaseSource

/**
 * The app for the JVM screenshot tests: the same graph, without the Android Keystore, and with
 * self-update asking [release] instead of GitHub (none unless a test sets one).
 */
class ShotsApp : CoreHubApp() {
    override fun makeGraph(): AppGraph = AppGraph(this, ReversingSealer(), ReleaseSource { Lookup.Answer(release) })

    companion object {
        @Volatile var release: AppRelease? = null
    }
}
