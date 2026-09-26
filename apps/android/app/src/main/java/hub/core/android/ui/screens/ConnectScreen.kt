package hub.core.android.ui.screens

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import hub.core.android.AppLanguage
import hub.core.android.generated.FontTokens
import hub.core.android.graph
import hub.core.android.ui.components.BrandMark
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.Hairline
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.HubTopBar
import hub.core.android.ui.kit.IconKind
import hub.core.android.ui.kit.Lucide
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import hub.core.android.R
import hub.core.android.data.PairingInput
import hub.core.android.data.PairingRequest
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.Notice
import hub.core.android.ui.components.Tone
import hub.core.android.ui.theme.LocalTokens

/** What this phone calls itself when it pairs: the name the person gave it, or its model. */
fun deviceName(context: android.content.Context): String =
    Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
        ?: "${Build.MANUFACTURER} ${Build.MODEL}"

/**
 * The screens before sign-in (`preAuth` in navigation.json: `login` and `setup`). Two ways in:
 * scan the pairing QR a signed-in client shows (Settings → Device connections on the web or the
 * desktop app), or type the hub's address and sign in with a name and password.
 */
@Composable
fun ConnectScreen(pendingPairing: PairingRequest?, onPairingHandled: () -> Unit) {
    val context = LocalContext.current
    val vm: ConnectViewModel = viewModel { ConnectViewModel(context.graph) }
    val state by vm.state.collectAsState()
    val scan = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@rememberLauncherForActivityResult
        vm.claim(PairingInput.parse(contents), deviceName(context))
    }
    LaunchedEffect(pendingPairing) {
        if (pendingPairing != null) {
            vm.claim(pendingPairing, deviceName(context))
            onPairingHandled()
        }
    }
    val scanPrompt = stringResource(R.string.connect_scan_prompt)

    val graph = context.graph
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().testTag("screen.sign_in")) {
        // As on iOS: the page's title, and the language at the end (the only choice before signing in).
        HubTopBar(
            stringResource(R.string.term_login),
            actions = {
                val lang = graph.prefs.effectiveLanguage
                HubIconButton(
                    Lucide.Globe, stringResource(R.string.shell_language) + ": " + (if (lang == AppLanguage.AR) "English" else "العربية"),
                    {
                        graph.prefs.language = if (lang == AppLanguage.AR) AppLanguage.EN else AppLanguage.AR
                        (context as? android.app.Activity)?.recreate()
                    },
                    kind = IconKind.Glass, modifier = Modifier.testTag("sign_in.language"),
                )
            },
        )
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 480.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                BrandMark(44)
                Text(stringResource(R.string.app_name), fontSize = FontTokens.size2xl.sp, fontWeight = FontWeight.Bold)
                when (state.step) {
                    ConnectStep.HUB -> HubStep(
                        state = state,
                        onHubText = vm::setHubText,
                        onContinue = vm::continueToHub,
                        onScan = {
                            scan.launch(
                                ScanOptions()
                                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                    .setPrompt(scanPrompt)
                                    .setBeepEnabled(false)
                                    .setOrientationLocked(false),
                            )
                        },
                        onPaste = { vm.claim(PairingInput.parse(it), deviceName(context)) },
                    )
                    ConnectStep.LOGIN -> LoginStep(state, onBack = vm::backToHub, onSignIn = vm::signIn)
                    ConnectStep.SETUP -> SetupStep(state, onBack = vm::backToHub, onSetup = vm::completeSetup)
                }
            }
        }
    }
}

/** «or» between two ways in, as on iOS and the web. */
@Composable
private fun OrDivider() {
    val t = LocalTokens.current
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Hairline(Modifier.weight(1f))
        Text(stringResource(R.string.connect_or), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
        Hairline(Modifier.weight(1f))
    }
}

@Composable
private fun HubStep(
    state: ConnectState,
    onHubText: (String) -> Unit,
    onContinue: () -> Unit,
    onScan: () -> Unit,
    onPaste: (String) -> Unit,
) {
    val t = LocalTokens.current
    Text(stringResource(R.string.connect_scan_body), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
    // One primary action: scanning the code another client shows.
    HubButton(
        stringResource(R.string.connect_scan), onScan, enabled = !state.busy, icon = Lucide.QrCode, fill = true,
        modifier = Modifier.fillMaxWidth().testTag("sign_in.scan"),
    )
    if (state.invalidPairing) Notice(stringResource(R.string.connect_pairing_invalid), Tone.WARNING)
    PasteCode(enabled = !state.busy, onPaste = onPaste)
    OrDivider()
    Text(stringResource(R.string.connect_or_address), fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold)
    HubTextField(
        state.hubText, onHubText,
        label = stringResource(R.string.connect_hub_label), placeholder = "hub.example.com", mono = true,
        error = if (state.invalidHub) stringResource(R.string.connect_hub_invalid) else null,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
        keyboardActions = KeyboardActions(onGo = { if (!state.busy && state.hubText.isNotBlank()) onContinue() }),
        modifier = Modifier.fillMaxWidth(), fieldTag = "sign_in.hub",
    )
    ErrorNotice(state.error)
    HubButton(
        stringResource(R.string.connect_continue), onContinue, kind = ButtonKind.Secondary, fill = true,
        enabled = !state.busy && state.hubText.isNotBlank(), loading = state.busy, modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun PasteCode(enabled: Boolean, onPaste: (String) -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    var text by rememberSaveable { mutableStateOf("") }
    if (!open) {
        HubButton(
            stringResource(R.string.connect_paste_open), { open = true }, kind = ButtonKind.Subtle, enabled = enabled, icon = Lucide.Copy, fill = true,
            modifier = Modifier.fillMaxWidth().testTag("sign_in.paste"),
        )
        return
    }
    HubTextField(text, { text = it }, label = stringResource(R.string.connect_paste_label), singleLine = false, minLines = 2, mono = true, modifier = Modifier.fillMaxWidth())
    HubButton(
        stringResource(R.string.connect_paste_claim), { onPaste(text) }, kind = ButtonKind.Subtle, fill = true,
        enabled = enabled && text.isNotBlank(), modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun LoginStep(state: ConnectState, onBack: () -> Unit, onSignIn: (String, String) -> Unit) {
    var username by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Text(state.hubName?.let { "$it · ${state.hub}" } ?: state.hub.orEmpty(), fontSize = FontTokens.sizeSm.sp, color = LocalTokens.current.textMuted)
    HubTextField(username, { username = it }, label = stringResource(R.string.connect_username), modifier = Modifier.fillMaxWidth())
    HubTextField(
        password, { password = it }, label = stringResource(R.string.connect_password),
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
        modifier = Modifier.fillMaxWidth(),
    )
    ErrorNotice(state.error)
    HubButton(
        stringResource(R.string.term_login), { onSignIn(username, password) }, fill = true, loading = state.busy,
        enabled = !state.busy && username.isNotBlank() && password.isNotEmpty(), modifier = Modifier.fillMaxWidth(),
    )
    HubButton(stringResource(R.string.connect_other_hub), onBack, kind = ButtonKind.Ghost, icon = Lucide.ArrowLeft)
}

@Composable
private fun SetupStep(state: ConnectState, onBack: () -> Unit, onSetup: (String, String, String, String) -> Unit) {
    var username by rememberSaveable { mutableStateOf("") }
    var displayName by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    Text(stringResource(R.string.term_setup), fontSize = FontTokens.sizeXl.sp, fontWeight = FontWeight.SemiBold)
    Text(
        stringResource(if (state.setupOpen) R.string.setup_open_body else R.string.setup_token_body),
        fontSize = FontTokens.sizeSm.sp, color = LocalTokens.current.textMuted,
    )
    HubTextField(username, { username = it }, label = stringResource(R.string.connect_username), modifier = Modifier.fillMaxWidth())
    HubTextField(displayName, { displayName = it }, label = stringResource(R.string.setup_display_name), modifier = Modifier.fillMaxWidth())
    HubTextField(
        password, { password = it }, label = stringResource(R.string.connect_password),
        visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
    )
    HubTextField(
        confirm, { confirm = it }, label = stringResource(R.string.setup_confirm),
        error = if (confirm.isNotEmpty() && confirm != password) "≠" else null,
        visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
    )
    if (!state.setupOpen) {
        HubTextField(token, { token = it }, label = stringResource(R.string.setup_token), mono = true, modifier = Modifier.fillMaxWidth())
    }
    ErrorNotice(state.error)
    HubButton(
        stringResource(R.string.setup_create), { onSetup(username, displayName, password, token) }, fill = true, loading = state.busy,
        enabled = !state.busy && username.isNotBlank() && password.isNotEmpty() && password == confirm, modifier = Modifier.fillMaxWidth(),
    )
    HubButton(stringResource(R.string.connect_other_hub), onBack, kind = ButtonKind.Ghost, icon = Lucide.ArrowLeft)
}
