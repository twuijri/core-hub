package hub.core.android.phone

import android.speech.SpeechRecognizer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
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
import hub.core.android.ui.components.ListRow
import hub.core.android.ui.components.Notice
import hub.core.android.ui.screens.ShellViewModel
import hub.core.android.ui.screens.localTime
import hub.core.android.ui.screens.term
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Release
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.coroutines.launch

@Composable
private fun SwitchRow(title: String, subtitle: String?, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    ListRow(title, subtitle, trailing = { Switch(checked = checked, onCheckedChange = onChange, enabled = enabled) })
}

@Composable
private fun Heading(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp, start = 4.dp))
}

/**
 * This device (NAVIGATION.md §2): the hub connection, voice input and its language, spoken
 * replies, notifications, and self-update where Android allows it. Everything here is this
 * phone's own and stays on it.
 */
@Composable
fun ThisDevicePage(shell: ShellViewModel) {
    val context = LocalContext.current
    val graph = context.graph
    val session by shell.session.collectAsState()
    val choices by graph.device.choices.collectAsState()
    val s = session ?: return
    val recognizer = remember { SpeechRecognizer.isRecognitionAvailable(context) }

    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        item { Heading(stringResource(R.string.device_connection)) }
        item {
            ListRow(
                s.hub,
                stringResource(if (s.kind == TokenKind.APP) R.string.device_paired else R.string.device_signed_in) +
                    (s.expiresAt?.let { " · " + stringResource(R.string.device_until, localTime(Instant.ofEpochMilli(it).atOffset(ZoneOffset.UTC))) } ?: ""),
            )
        }
        item { OutlinedButton(onClick = shell::signOut, modifier = Modifier.fillMaxWidth()) { Text(term("sign_out")) } }

        item { Heading(stringResource(R.string.voice_heading)) }
        item {
            Column(Modifier.padding(horizontal = 4.dp)) {
                Text(stringResource(R.string.voice_source), style = MaterialTheme.typography.labelLarge)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(VoiceSource.HUB to R.string.voice_source_hub, VoiceSource.PHONE to R.string.voice_source_phone).forEach { (v, label) ->
                        FilterChip(
                            selected = choices.voiceSource == v,
                            onClick = { graph.device.update { it.copy(voiceSource = v) } },
                            label = { Text(stringResource(label)) },
                            modifier = Modifier.testTag("device.voice_source.${v.name.lowercase()}"),
                        )
                    }
                }
                Text(stringResource(R.string.voice_source_hint), style = MaterialTheme.typography.bodySmall, color = LocalTokens.current.textMuted)
            }
        }
        item {
            SwitchRow(
                stringResource(R.string.voice_input),
                stringResource(if (recognizer) R.string.voice_input_hint else R.string.voice_unavailable),
                choices.voiceInput && recognizer, enabled = recognizer,
            ) { on -> graph.device.update { it.copy(voiceInput = on) } }
        }
        item {
            Column(Modifier.padding(horizontal = 4.dp)) {
                Text(stringResource(R.string.voice_language), style = MaterialTheme.typography.labelLarge)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(
                        Dictation.APP to stringResource(R.string.voice_language_app, if (graph.prefs.effectiveLanguage == AppLanguage.AR) "العربية" else "English"),
                        Dictation.AR to "العربية",
                        Dictation.EN to "English",
                    ).forEach { (d, label) ->
                        FilterChip(selected = choices.dictation == d, onClick = { graph.device.update { it.copy(dictation = d) } }, label = { Text(label) })
                    }
                }
            }
        }
        item {
            SwitchRow(stringResource(R.string.voice_spoken), stringResource(R.string.voice_spoken_hint), choices.spokenReplies) { on ->
                graph.device.update { it.copy(spokenReplies = on) }
                if (!on) graph.speaker.stop()
            }
        }

        item { Heading(term("notifications")) }
        item { NotificationRows() }
        item {
            SwitchRow(stringResource(R.string.notices_background), stringResource(R.string.notices_background_hint), choices.backgroundNotices) { on ->
                // AppGraph schedules or stops the check from this choice and the push state.
                graph.device.update { it.copy(backgroundNotices = on) }
            }
        }

        item { Heading(stringResource(R.string.update_heading)) }
        item { UpdateSection() }
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
        ListRow(stringResource(R.string.update_installed, BuildConfig.VERSION_NAME), null)
        when (val st = state) {
            UpdateState.Checking, UpdateState.Downloading -> Text(stringResource(R.string.loading), color = t.textMuted)
            is UpdateState.UpToDate -> Text(
                stringResource(if (st.reason == "not_configured") R.string.update_not_configured else R.string.update_none),
                color = t.textMuted,
            )
            is UpdateState.Failed -> if (st.error != null) ErrorNotice(st.error) else Notice(stringResource(R.string.update_bad_file))
            is UpdateState.Available -> {
                val notes = if (graph.prefs.effectiveLanguage == AppLanguage.AR) st.release.notes.ar else st.release.notes.en
                ListRow(stringResource(R.string.update_available, st.release.version), notes)
                Button(onClick = {
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
                }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.update_install)) }
            }
            UpdateState.Idle -> Unit
        }
        OutlinedButton(
            onClick = {
                state = UpdateState.Checking
                scope.launch {
                    val session = graph.store.current ?: return@launch
                    hubCall { Updates.check(graph.apis(session)) }
                        .onSuccess { check -> state = if (check.available && check.release != null) UpdateState.Available(check.release!!) else UpdateState.UpToDate(check.reason?.value) }
                        .onFailure { state = UpdateState.Failed(it as HubError) }
                }
            },
            enabled = state != UpdateState.Checking && state != UpdateState.Downloading,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(stringResource(R.string.update_check)) }
    }
}
