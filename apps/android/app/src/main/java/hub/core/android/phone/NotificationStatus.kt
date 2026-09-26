package hub.core.android.phone

import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.Custom
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.generated.FontTokens
import hub.core.android.ui.theme.LocalTokens
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.sp
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.Lucide
import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import hub.core.android.R
import hub.core.android.graph

/*
 * Notifications on this phone, in plain words (owner, 2026-09-25): whether the app may show them,
 * whether the hub pushes to this phone, and what the person can do about it.
 */

/**
 * When to show Android's notification prompt (Android 13+): only while it is not granted, only
 * if the person has not said no before, and at most once a launch — a prompt closed without an
 * answer comes back at the next launch; a no is never asked again (the row opens Settings then).
 */
object NotificationAsk {
    /** Once a launch: the process's own memory, not the phone's. */
    @Volatile
    var askedThisLaunch: Boolean = false

    fun shouldAsk(sdk: Int, granted: Boolean, deniedBefore: Boolean, askedThisLaunch: Boolean): Boolean =
        sdk >= 33 && !granted && !deniedBefore && !askedThisLaunch
}

object PushStatus {
    /** The state in plain words, for the row: the permission first, then the hub's push. */
    fun label(push: PushState, allowed: Boolean, denied: Boolean): Int = when {
        !allowed && denied -> R.string.push_off
        !allowed -> R.string.push_waiting
        else -> when (push) {
            PushState.ACTIVE -> R.string.push_on
            PushState.IDLE -> R.string.push_setting_up
            PushState.NO_SENDER -> R.string.push_no_sender
            PushState.FAILED -> R.string.push_failed
            PushState.NOT_IN_BUILD -> R.string.push_not_in_build
        }
    }

    /** The longer note under it: what happens meanwhile. */
    fun note(push: PushState): Int = when (push) {
        PushState.ACTIVE -> R.string.notices_push_active
        PushState.IDLE -> R.string.notices_push_checking
        PushState.NOT_IN_BUILD -> R.string.notices_push_not_in_build
        PushState.NO_SENDER -> R.string.notices_push_no_sender
        PushState.FAILED -> R.string.notices_push_failed
    }

    /** Worth registering again when the app comes to the front: the hub may have a sender now. */
    fun retriesOnForeground(push: PushState): Boolean =
        push == PushState.IDLE || push == PushState.NO_SENDER || push == PushState.FAILED
}

/**
 * The notification rows of This device and Settings → Notifications: the state, the note, and
 * «Allow notifications» while Android can still ask, or «Open Settings» once the person said no.
 */
@Composable
fun NotificationRows() {
    val context = LocalContext.current
    val graph = context.graph
    val push by graph.push.state.collectAsState()
    var tick by remember { mutableIntStateOf(0) }
    val notifier = remember { Notifier(context) }
    val allowed = remember(tick) { notifier.allowed() }
    val denied = remember(tick) { graph.device.notificationsDenied || (Build.VERSION.SDK_INT < 33 && !allowed) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) graph.device.notificationsDenied = true
        tick++
        // The answer changes what stops push here: the hub's device card hears it at once.
        graph.reportDevice()
    }
    // Back from the phone's Settings: read the permission again.
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) tick++ }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    // The state is a tinted badge with a dot; what it means is the line under it.
    val tone = when {
        !allowed -> BadgeTone.Danger
        push == PushState.ACTIVE -> BadgeTone.Success
        else -> BadgeTone.Warning
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        GroupedList {
            Custom(Modifier.testTag("push.state")) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    LucideIcon(Lucide.Bell, null, size = 20.dp, tint = LocalTokens.current.textMuted)
                    Text(stringResource(R.string.push_label), fontSize = FontTokens.sizeMd.sp, modifier = Modifier.weight(1f))
                    Badge(stringResource(PushStatus.label(push, allowed, denied)), tone = tone, dot = true)
                }
                Text(stringResource(PushStatus.note(push)), fontSize = FontTokens.sizeSm.sp, color = LocalTokens.current.textMuted)
            }
        }
        if (!allowed && !denied && Build.VERSION.SDK_INT >= 33) {
            HubButton(stringResource(R.string.notices_allow), {
                NotificationAsk.askedThisLaunch = true
                ask.launch(Manifest.permission.POST_NOTIFICATIONS)
            }, icon = Lucide.Bell, fill = true, modifier = Modifier.fillMaxWidth())
        } else if (!allowed) {
            HubButton(
                stringResource(R.string.notices_off) + " — " + stringResource(R.string.notices_open_settings), {
                    context.startActivity(
                        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                },
                kind = ButtonKind.Secondary, icon = Lucide.ExternalLink, fill = true, modifier = Modifier.fillMaxWidth().testTag("push.open_settings"),
            )
        }
    }
}

/** Asks, while signed in, for the permission Android 13+ needs before a notice can be shown (NotificationAsk). */
@Composable
fun NotificationPermission() {
    val context = LocalContext.current
    val graph = context.graph
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) graph.device.notificationsDenied = true
        graph.reportDevice()
    }
    LaunchedEffect(Unit) {
        val granted = Notifier(context).allowed()
        if (Build.VERSION.SDK_INT >= 33 &&
            NotificationAsk.shouldAsk(Build.VERSION.SDK_INT, granted, graph.device.notificationsDenied, NotificationAsk.askedThisLaunch)
        ) {
            NotificationAsk.askedThisLaunch = true
            ask.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
