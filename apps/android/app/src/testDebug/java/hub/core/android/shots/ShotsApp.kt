package hub.core.android.shots

import hub.core.android.AppGraph
import hub.core.android.CoreHubApp
import hub.core.android.ReversingSealer

/** The app for the JVM screenshot tests: the same graph, without the Android Keystore. */
class ShotsApp : CoreHubApp() {
    override fun makeGraph(): AppGraph = AppGraph(this, ReversingSealer())
}
