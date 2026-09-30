package hub.core.android.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.generated.FontTokens
import hub.core.android.graph
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.AgentKind
import hub.core.client.model.RuntimeCheck
import hub.core.client.model.RuntimeReport
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * The Runtime card on Models → Providers (the web's RuntimeCard, ADR 0010): did the agent runtime
 * take what this profile configured — its files writable, the keys in its environment, the
 * providers verified, a chat model chosen, restarted since the last change. All passing, it is one
 * line that opens the list; a failing check opens it by itself, failures first. A pending restart
 * is amber, with «Restart now» for whoever may restart Hermes. Native since 2026-09-27.
 */

object RuntimeRules {
    private val ORDER = listOf(
        RuntimeCheck.Id.RUNTIME_WRITABLE, RuntimeCheck.Id.PROVIDER_KEYS, RuntimeCheck.Id.PROVIDER_VERIFIED,
        RuntimeCheck.Id.MODEL_SELECTED, RuntimeCheck.Id.GATEWAY_RELOADED,
    )

    fun sorted(checks: List<RuntimeCheck>): List<RuntimeCheck> = checks.sortedBy { ORDER.indexOf(it.id) }

    /** What failed first, each half in the order the steps happen in. */
    fun failingFirst(checks: List<RuntimeCheck>): List<RuntimeCheck> = sorted(checks).let { s -> s.filter { !it.ok } + s.filter { it.ok } }

    fun passed(report: RuntimeReport): Int = report.checks.count { it.ok }

    fun allOk(report: RuntimeReport): Boolean = report.checks.isNotEmpty() && report.checks.all { it.ok }

    /** Only the pending restart fails: amber, not red. */
    fun onlyRestart(report: RuntimeReport): Boolean = report.checks.all { it.ok || it.id == RuntimeCheck.Id.GATEWAY_RELOADED }

    /** The hub's own restart of Hermes on its way (DECISIONS §145): `scheduled` or `waiting_for_run`. */
    fun restartOnItsWay(check: RuntimeCheck): Boolean =
        check.id == RuntimeCheck.Id.GATEWAY_RELOADED && !check.ok && (check.detail == "scheduled" || check.detail == "waiting_for_run")

    fun restartOnItsWay(report: RuntimeReport): Boolean = report.checks.any { restartOnItsWay(it) }

    /** «Restart now» only when no restart of the hub's own is coming: the way out, not the normal flow. */
    fun needsRestart(report: RuntimeReport): Boolean =
        report.checks.any { it.id == RuntimeCheck.Id.GATEWAY_RELOADED && !it.ok && !restartOnItsWay(it) }
}

@Composable
private fun checkText(check: RuntimeCheck): String = stringResource(
    when (check.id) {
        RuntimeCheck.Id.RUNTIME_WRITABLE -> if (check.ok) R.string.runtime_runtime_writable_ok else R.string.runtime_runtime_writable_missing
        RuntimeCheck.Id.PROVIDER_KEYS -> if (check.ok) R.string.runtime_provider_keys_ok else R.string.runtime_provider_keys_missing
        RuntimeCheck.Id.PROVIDER_VERIFIED -> if (check.ok) R.string.runtime_provider_verified_ok else R.string.runtime_provider_verified_missing
        RuntimeCheck.Id.MODEL_SELECTED -> if (check.ok) R.string.runtime_model_selected_ok else R.string.runtime_model_selected_missing
        RuntimeCheck.Id.GATEWAY_RELOADED -> when {
            check.ok -> R.string.runtime_gateway_reloaded_ok
            check.detail == "scheduled" -> R.string.runtime_gateway_reloaded_scheduled
            check.detail == "waiting_for_run" -> R.string.runtime_gateway_reloaded_waiting_for_run
            else -> R.string.runtime_gateway_reloaded_missing
        }
    },
)

@Composable
internal fun RuntimeCard(profile: String, isAdmin: Boolean, reloadKey: Any?) {
    val context = LocalContext.current
    val graph = context.graph
    val scope = rememberCoroutineScope()
    var report by remember(profile) { mutableStateOf<RuntimeReport?>(null) }
    var error by remember(profile) { mutableStateOf<HubError?>(null) }
    var tick by remember { androidx.compose.runtime.mutableIntStateOf(0) }
    LaunchedEffect(profile, reloadKey, tick) {
        val s = graph.store.current ?: return@LaunchedEffect
        hubCall { graph.apis(s).models.modelsGetRuntime(profile) }.onSuccess { report = it; error = null }.onFailure { error = it as HubError }
        // While the hub's own restart is on its way, ask again until it has happened.
        if (report?.let { RuntimeRules.restartOnItsWay(it) } == true) {
            delay(2_000)
            tick++
        }
    }
    val r = report ?: run { if (error != null && error?.status != 404 && error?.status != 501) ErrorNotice(error); return }
    RuntimeCardView(r, isAdmin) {
        scope.launch {
            val s = graph.store.current ?: return@launch
            val apis = graph.apis(s)
            val hermes = hubCall { apis.agents.agentsList(profile).items }.getOrNull()?.firstOrNull { it.kind == AgentKind.HERMES }
                ?: return@launch
            hubCall { apis.agents.agentsRestart(profile, hermes.id) }.onFailure { error = it as HubError }
            delay(3_000)
            tick++
        }
    }
}

@Composable
internal fun RuntimeCardView(report: RuntimeReport, canRestart: Boolean, onRestart: () -> Unit = {}) {
    val t = LocalTokens.current
    val all = RuntimeRules.allOk(report)
    var expanded by remember { mutableStateOf(false) }
    val open = !all || expanded
    val total = report.checks.size
    val passed = RuntimeRules.passed(report)
    var restarting by remember { mutableStateOf(false) }
    HubCard(Modifier.testTag("models.runtime"), padding = 12.dp) {
        Row(
            Modifier.fillMaxWidth().then(if (all) Modifier.clickable { expanded = !expanded } else Modifier),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (all) {
                Badge(stringResource(R.string.runtime_ready, passed.toString(), total.toString()), tone = BadgeTone.Success, dot = true)
            } else {
                Text(stringResource(R.string.runtime_title), fontSize = FontTokens.sizeSm.sp, fontWeight = FontWeight.Medium)
                if (total > 0) {
                    Badge(
                        stringResource(R.string.runtime_passed, passed.toString(), total.toString()),
                        tone = if (RuntimeRules.onlyRestart(report)) BadgeTone.Warning else BadgeTone.Danger, dot = true,
                    )
                }
            }
            androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            if (all) LucideIcon(if (open) Lucide.ChevronUp else Lucide.ChevronDown, null, size = 16.dp, tint = t.textMuted)
        }
        if (open) {
            Text(stringResource(R.string.runtime_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
            RuntimeRules.failingFirst(report.checks).forEach { check ->
                val warn = !check.ok && check.id == RuntimeCheck.Id.GATEWAY_RELOADED
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("runtime.check.${check.id.value}")) {
                    LucideIcon(
                        if (check.ok) Lucide.Check else if (warn) Lucide.TriangleAlert else Lucide.CircleX, null, size = 14.dp,
                        tint = if (check.ok) t.successSoftText else if (warn) t.warningSoftText else t.danger,
                    )
                    Text(
                        checkText(check), Modifier.weight(1f), fontSize = FontTokens.sizeSm.sp,
                        fontWeight = if (check.ok) FontWeight.Normal else FontWeight.Medium, color = if (warn) t.warningSoftText else t.text,
                    )
                    check.detail?.takeIf { check.id != RuntimeCheck.Id.GATEWAY_RELOADED }?.let { Text(it, fontSize = FontTokens.sizeXs.sp, color = t.textMuted) }
                }
            }
            if (canRestart && RuntimeRules.needsRestart(report)) {
                HubButton(
                    stringResource(R.string.runtime_restart_now), { restarting = true; onRestart() }, size = ControlSize.Sm, icon = Lucide.RotateCw,
                    loading = restarting, modifier = Modifier.testTag("runtime.restart"),
                )
            }
        }
    }
}
