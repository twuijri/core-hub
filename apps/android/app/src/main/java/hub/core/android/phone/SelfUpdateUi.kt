package hub.core.android.phone

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.BuildConfig
import hub.core.android.R
import hub.core.android.generated.FontTokens
import hub.core.android.graph
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.theme.LocalTokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File

/**
 * Self-update on the phone (SelfUpdate.kt): the checker, the download with its progress, and the
 * hand-over to Android's installer. One per process ([hub.core.android.AppGraph.updates]); the
 * notice on New chat, the row in Settings and This device all read the same state.
 */
class SelfUpdate(
    private val context: Context,
    val checker: UpdateChecker,
    private val downloader: ApkDownloader,
    private val scope: CoroutineScope,
    private val inForeground: () -> Boolean,
) {
    sealed interface Task {
        data object Idle : Task
        data class Downloading(val percent: Int) : Task

        /** Downloaded and checked; waiting for a tap (the app was in the background when it finished). */
        data class Ready(val release: AppRelease) : Task

        /** Android needs "Install unknown apps" for Core Hub first. */
        data class NeedsPermission(val release: AppRelease) : Task
        data class Failed(val badFile: Boolean) : Task
    }

    private val dir = File(context.cacheDir, "updates")
    private val _task = MutableStateFlow<Task>(Task.Idle)
    val task: StateFlow<Task> = _task.asStateFlow()
    val enabled: Boolean get() = checker.enabled

    init {
        // An installed update leaves its APK in the cache: keep only the one still on offer.
        scope.launch(Dispatchers.IO) { runCatching { downloader.clean(dir, checker.available.value) } }
    }

    /** The app came to the front (MainActivity.onStart): ask GitHub when due. */
    fun onForeground() {
        if (enabled) scope.launch { runCatching { checker.checkIfDue() } }
    }

    suspend fun checkNow(): CheckResult = runCatching { checker.checkNow() }.getOrDefault(CheckResult.UNREACHABLE)

    fun later(release: AppRelease) = checker.later(release.version)

    fun update(release: AppRelease) {
        if (!enabled || _task.value is Task.Downloading) return
        scope.launch {
            try {
                val apk = downloader.ready(release, dir) ?: run {
                    _task.value = Task.Downloading(0)
                    downloader.download(release, dir) { read, total ->
                        val percent = (read * 100 / total).toInt().coerceIn(0, 100)
                        if ((_task.value as? Task.Downloading)?.percent != percent) _task.value = Task.Downloading(percent)
                    }
                }
                install(release, apk)
            } catch (e: CancellationException) {
                throw e
            } catch (e: BadDownload) {
                _task.value = Task.Failed(badFile = true)
            } catch (e: Exception) {
                _task.value = Task.Failed(badFile = false)
            }
        }
    }

    private fun install(release: AppRelease, apk: File) {
        if (!context.packageManager.canRequestPackageInstalls()) {
            _task.value = Task.NeedsPermission(release)
            return
        }
        // Android does not open an activity for an app in the background: wait for a tap.
        if (!inForeground()) {
            _task.value = Task.Ready(release)
            return
        }
        _task.value = Task.Idle
        context.startActivity(Updates.installIntent(context, apk))
    }

    /** Android's "Install unknown apps" page for Core Hub. */
    fun openInstallSetting() {
        context.startActivity(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}

/**
 * The notice on New chat: compact, in a solid card, with Update and Later. Later hides this
 * version until a newer one; This device still offers it.
 */
@Composable
fun UpdateBanner(modifier: Modifier = Modifier) {
    val updates = LocalContext.current.graph.updates
    if (!updates.enabled) return
    val available by updates.checker.available.collectAsState()
    val skipped by updates.checker.skipped.collectAsState()
    val release = ReleaseRules.notice(available, skipped) ?: return
    val t = LocalTokens.current
    HubCard(modifier.testTag("update.banner"), padding = 12.dp) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            LucideIcon(Lucide.CircleArrowDown, null, size = 20.dp, tint = t.accent)
            Column(Modifier.weight(1f)) {
                Text(
                    stringResource(R.string.update_banner_title, stringResource(R.string.app_name), release.version),
                    fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.SemiBold,
                )
                Text(ReleaseRules.formatSize(release.size), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            }
        }
        UpdateActions(release, showLater = true)
    }
}

/** What "Update" leads to: the download's progress, Android's setting, or a failure — and the buttons. */
@Composable
private fun UpdateActions(release: AppRelease, showLater: Boolean) {
    val updates = LocalContext.current.graph.updates
    val task by updates.task.collectAsState()
    val t = LocalTokens.current
    val appName = stringResource(R.string.app_name)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (val st = task) {
            is SelfUpdate.Task.Downloading -> {
                Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(t.surface2).testTag("update.progress")) {
                    Box(Modifier.fillMaxWidth(st.percent / 100f).fillMaxHeight().background(t.accent))
                }
                Text(stringResource(R.string.update_downloading, st.percent), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            }
            is SelfUpdate.Task.NeedsPermission -> {
                Text(stringResource(R.string.update_allow_hint, appName), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HubButton(stringResource(R.string.update_allow_open), updates::openInstallSetting, size = ControlSize.Md, icon = Lucide.Settings, modifier = Modifier.testTag("update.allow"))
                    HubButton(stringResource(R.string.update_install_ready), { updates.update(release) }, kind = ButtonKind.Secondary, size = ControlSize.Md)
                }
            }
            is SelfUpdate.Task.Ready -> HubButton(
                stringResource(R.string.update_install_ready), { updates.update(release) }, size = ControlSize.Md, icon = Lucide.Download,
            )
            is SelfUpdate.Task.Failed, SelfUpdate.Task.Idle -> {
                if (st is SelfUpdate.Task.Failed) {
                    Text(
                        stringResource(if (st.badFile) R.string.update_bad_file else R.string.update_failed),
                        fontSize = FontTokens.sizeXs.sp, color = t.danger,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HubButton(
                        stringResource(if (st is SelfUpdate.Task.Failed) R.string.retry else R.string.update_now), { updates.update(release) },
                        size = ControlSize.Md, icon = Lucide.Download, modifier = Modifier.testTag("update.now"),
                    )
                    if (showLater) {
                        HubButton(stringResource(R.string.update_later), { updates.later(release) }, kind = ButtonKind.Ghost, size = ControlSize.Md, modifier = Modifier.testTag("update.later"))
                    }
                }
            }
        }
    }
}

/** Settings' row while a newer version is on offer: it opens This device, where Update is. */
@Composable
fun UpdateSettingsRow(onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val updates = LocalContext.current.graph.updates
    if (!updates.enabled) return
    val release by updates.checker.available.collectAsState()
    val r = release ?: return
    GroupedList(modifier) {
        Item(
            stringResource(R.string.update_banner_title, stringResource(R.string.app_name), r.version),
            subtitle = ReleaseRules.formatSize(r.size), icon = Lucide.CircleArrowDown, iconTint = LocalTokens.current.accent,
            chevron = true, tag = "settings.update", onClick = onOpen,
        )
    }
}

/**
 * This device's Updates part: the installed version, the newer one when found (with Update even
 * after Later), its notes on GitHub, and "Check for updates". A Play build only says Play updates it.
 */
@Composable
fun SelfUpdateSection() {
    val context = LocalContext.current
    val updates = context.graph.updates
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val available by updates.checker.available.collectAsState()
    var checking by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<CheckResult?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("device.updates")) {
        GroupedList {
            Item(stringResource(R.string.update_installed, BuildConfig.VERSION_NAME), icon = Lucide.Smartphone)
            available?.let { r ->
                Item(
                    stringResource(R.string.update_available, r.version), subtitle = ReleaseRules.formatSize(r.size),
                    icon = Lucide.CircleArrowDown, iconTint = t.accent,
                )
                Item(
                    stringResource(R.string.update_notes), icon = Lucide.FileText,
                    trailing = { LucideIcon(Lucide.ExternalLink, null, size = 16.dp, tint = t.textFaint) },
                    onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(r.pageUrl))) } },
                )
            }
        }
        if (!updates.enabled) {
            NoticeBox(stringResource(R.string.update_store), BadgeTone.Info)
            return@Column
        }
        available?.let { UpdateActions(it, showLater = false) }
        when (result) {
            CheckResult.UP_TO_DATE -> NoticeBox(stringResource(R.string.update_none), BadgeTone.Success)
            CheckResult.RATE_LIMITED -> NoticeBox(stringResource(R.string.update_rate_limited), BadgeTone.Warning)
            CheckResult.UNREACHABLE -> NoticeBox(stringResource(R.string.update_unreachable), BadgeTone.Warning)
            else -> Unit
        }
        HubButton(
            stringResource(R.string.update_check),
            {
                checking = true
                result = null
                scope.launch {
                    result = updates.checkNow()
                    checking = false
                }
            },
            kind = ButtonKind.Secondary, icon = Lucide.RefreshCw, fill = true, loading = checking, enabled = !checking,
            modifier = Modifier.fillMaxWidth().testTag("device.update_check"),
        )
        Text(stringResource(R.string.update_auto_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
    }
}
