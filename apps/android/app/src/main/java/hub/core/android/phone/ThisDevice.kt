package hub.core.android.phone

import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.sp
import hub.core.android.generated.FontTokens
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.Custom
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubSwitch
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.SectionTitle
import hub.core.android.ui.kit.Segment
import hub.core.android.ui.kit.Segmented
import hub.core.android.ui.kit.Spinner
import hub.core.android.ui.kit.StatusDot
import android.speech.SpeechRecognizer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import hub.core.android.AppLanguage
import hub.core.android.BuildConfig
import hub.core.android.R
import hub.core.android.data.HubError
import hub.core.android.data.TokenKind
import hub.core.android.data.hubCall
import hub.core.android.graph
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.Notice
import hub.core.android.ui.screens.ShellViewModel
import hub.core.android.ui.screens.localTime
import hub.core.android.ui.screens.term
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Release
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.coroutines.launch

/**
 * This device (NAVIGATION.md §2), as inset groups: the hub connection, voice input and its
 * language, spoken replies, notifications, and self-update where Android allows it. Everything
 * here is this phone's own and stays on it.
 */
@Composable
fun ThisDevicePage(shell: ShellViewModel) {
    val context = LocalContext.current
    val graph = context.graph
    val session by shell.session.collectAsState()
    val choices by graph.device.choices.collectAsState()
    val connected by graph.realtime.connected.collectAsState()
    val s = session ?: return
    val recognizer = remember { SpeechRecognizer.isRecognitionAvailable(context) }
    val t = LocalTokens.current
    var choosing by remember { mutableStateOf(false) }

    LazyColumn(Modifier.testTag("device.page"), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item {
            GroupedList(title = stringResource(R.string.device_connection)) {
                Item(
                    s.hub,
                    subtitle = stringResource(if (s.kind == TokenKind.APP) R.string.device_paired else R.string.device_signed_in) +
                        (s.expiresAt?.let { " · " + stringResource(R.string.device_until, localTime(Instant.ofEpochMilli(it).atOffset(ZoneOffset.UTC))) } ?: ""),
                    icon = Lucide.Server,
                    trailing = {
                        StatusDot(
                            if (connected) t.statusRunning else t.statusBlocked,
                            stringResource(if (connected) R.string.shell_connected else R.string.shell_offline),
                        )
                    },
                )
                Item(term("sign_out"), icon = Lucide.LogOut, danger = true, onClick = shell::signOut)
            }
        }
        item {
            GroupedList(title = stringResource(R.string.voice_heading)) {
                Custom {
                    Segmented(
                        listOf(
                            Segment(VoiceSource.HUB, stringResource(R.string.voice_source_hub), tag = "device.voice_source.hub"),
                            Segment(VoiceSource.PHONE, stringResource(R.string.voice_source_phone), tag = "device.voice_source.phone"),
                        ),
                        choices.voiceSource, { v -> graph.device.update { it.copy(voiceSource = v) } }, Modifier.fillMaxWidth(),
                    )
                    Text(stringResource(R.string.voice_source_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                }
                Item(
                    stringResource(R.string.voice_input),
                    subtitle = stringResource(if (recognizer) R.string.voice_input_hint else R.string.voice_unavailable),
                    icon = Lucide.Mic,
                    trailing = { HubSwitch(choices.voiceInput && recognizer, { on -> graph.device.update { it.copy(voiceInput = on) } }, enabled = recognizer) },
                )
                // Auto by default: the keyboard in use picks the language; any other can be chosen.
                Item(
                    stringResource(R.string.voice_language),
                    icon = Lucide.Globe,
                    value = if (choices.dictation == DictationLanguage.AUTO) stringResource(R.string.voice_language_auto)
                    else DictationLanguage.name(choices.dictation, graph.prefs.effectiveLanguage.tag),
                    chevron = true, tag = "device.dictation_language", onClick = { choosing = true },
                )
                Item(
                    stringResource(R.string.voice_spoken), subtitle = stringResource(R.string.voice_spoken_hint), icon = Lucide.Sparkles,
                    trailing = {
                        HubSwitch(choices.spokenReplies, { on ->
                            graph.device.update { it.copy(spokenReplies = on) }
                            if (!on) graph.speaker.stop()
                        })
                    },
                )
            }
        }
        item { SectionTitle(term("notifications")) }
        item { NotificationRows() }
        item {
            GroupedList(Modifier.padding(top = 8.dp)) {
                Item(
                    stringResource(R.string.notices_background), subtitle = stringResource(R.string.notices_background_hint), icon = Lucide.Clock,
                    // AppGraph schedules or stops the check from this choice and the push state.
                    trailing = { HubSwitch(choices.backgroundNotices, { on -> graph.device.update { it.copy(backgroundNotices = on) } }) },
                )
            }
        }
        // Whether an agent may ask where this phone is (§105): asked the first time, changed here.
        item { SectionTitle(stringResource(R.string.locate_heading)) }
        item { LocationChoiceRow() }
        item { SectionTitle(stringResource(R.string.update_heading)) }
        item { UpdateSection() }
    }
    if (choosing) {
        DictationLanguageDialog(
            choice = choices.dictation,
            onChoose = { tag -> graph.device.update { it.copy(dictation = tag) }; choosing = false },
            onDismiss = { choosing = false },
        )
    }
}

private sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data class UpToDate(val reason: String?) : UpdateState
    data class Available(val release: Release) : UpdateState
    data object Downloading : UpdateState
    data class Failed(val error: HubError?) : UpdateState
}

@Composable
private fun UpdateSection() {
    val context = LocalContext.current
    val graph = context.graph
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<UpdateState>(UpdateState.Idle) }
    val t = LocalTokens.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        GroupedList {
            Item(stringResource(R.string.update_installed, BuildConfig.VERSION_NAME), icon = Lucide.Smartphone)
            (state as? UpdateState.Available)?.let { st ->
                val notes = if (graph.prefs.effectiveLanguage == AppLanguage.AR) st.release.notes.ar else st.release.notes.en
                Item(stringResource(R.string.update_available, st.release.version), subtitle = notes, icon = Lucide.CircleArrowDown)
            }
        }
        when (val st = state) {
            UpdateState.Checking, UpdateState.Downloading -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Spinner(16.dp, t.textMuted)
                Text(stringResource(R.string.loading), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
            }
            is UpdateState.UpToDate -> NoticeBox(
                stringResource(if (st.reason == "not_configured") R.string.update_not_configured else R.string.update_none),
                if (st.reason == "not_configured") BadgeTone.Info else BadgeTone.Success,
            )
            is UpdateState.Failed -> if (st.error != null) ErrorNotice(st.error) else Notice(stringResource(R.string.update_bad_file))
            is UpdateState.Available -> {
                HubButton(stringResource(R.string.update_install), {
                    state = UpdateState.Downloading
                    scope.launch {
                        val session = graph.store.current ?: return@launch
                        try {
                            val apk = Updates.download(context, graph.apis(session), st.release)
                            context.startActivity(Updates.installIntent(context, apk))
                            state = UpdateState.Idle
                        } catch (e: SecurityException) {
                            state = UpdateState.Failed(null)
                        } catch (e: Exception) {
                            state = UpdateState.Failed(HubError.from(e))
                        }
                    }
                }, icon = Lucide.Download, fill = true, modifier = Modifier.fillMaxWidth())
            }
            UpdateState.Idle -> Unit
        }
        HubButton(
            stringResource(R.string.update_check),
            {
                state = UpdateState.Checking
                scope.launch {
                    val session = graph.store.current ?: return@launch
                    hubCall { Updates.check(graph.apis(session)) }
                        .onSuccess { check -> state = if (check.available && check.release != null) UpdateState.Available(check.release!!) else UpdateState.UpToDate(check.reason?.value) }
                        .onFailure { state = UpdateState.Failed(it as HubError) }
                }
            },
            kind = ButtonKind.Secondary, icon = Lucide.RefreshCw, fill = true,
            enabled = state != UpdateState.Checking && state != UpdateState.Downloading,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun LocationChoiceRow() {
    val graph = androidx.compose.ui.platform.LocalContext.current.graph
    val choice by graph.locationChoices.choice.collectAsState()
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Segmented(
            listOf(
                Segment(LocationChoice.ASK, stringResource(R.string.locate_ask), tag = "locate.choice.ask"),
                Segment(LocationChoice.ALWAYS, stringResource(R.string.locate_choice_always), tag = "locate.choice.always"),
                Segment(LocationChoice.NEVER, stringResource(R.string.locate_choice_never), tag = "locate.choice.never"),
            ),
            choice, { graph.locationChoices.set(it); graph.reportDevice() }, Modifier.fillMaxWidth(),
        )
        Text(stringResource(R.string.locate_hint), fontSize = FontTokens.sizeXs.sp, color = hub.core.android.ui.theme.LocalTokens.current.textMuted)
    }
}
