package hub.core.android.ui.screens

import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import hub.core.android.graph
import hub.core.android.ui.components.BrandName
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.Glyphs
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

    Column(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp).testTag("screen.sign_in"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(Modifier.widthIn(max = 480.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Spacer(Modifier.height(24.dp))
            BrandName()
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

@Composable
private fun HubStep(
    state: ConnectState,
    onHubText: (String) -> Unit,
    onContinue: () -> Unit,
    onScan: () -> Unit,
    onPaste: (String) -> Unit,
) {
    val t = LocalTokens.current
    Text(stringResource(R.string.connect_title), style = MaterialTheme.typography.headlineSmall)
    Text(stringResource(R.string.connect_scan_body), style = MaterialTheme.typography.bodyMedium, color = t.textMuted)
    Button(onClick = onScan, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
        Icon(Glyphs.Qr, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.size(8.dp))
        Text(stringResource(R.string.connect_scan))
    }
    if (state.invalidPairing) Notice(stringResource(R.string.connect_pairing_invalid), Tone.WARNING)
    PasteCode(enabled = !state.busy, onPaste = onPaste)
    HorizontalDivider()
    Text(stringResource(R.string.connect_or_address), style = MaterialTheme.typography.titleSmall)
    OutlinedTextField(
        value = state.hubText,
        onValueChange = onHubText,
        label = { Text(stringResource(R.string.connect_hub_label)) },
        placeholder = { Text("hub.example.com") },
        singleLine = true,
        isError = state.invalidHub,
        supportingText = if (state.invalidHub) ({ Text(stringResource(R.string.connect_hub_invalid)) }) else null,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
        modifier = Modifier.fillMaxWidth(),
    )
    ErrorNotice(state.error)
    OutlinedButton(onClick = onContinue, enabled = !state.busy && state.hubText.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.connect_continue))
    }
}

@Composable
private fun PasteCode(enabled: Boolean, onPaste: (String) -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    var text by rememberSaveable { mutableStateOf("") }
    if (!open) {
        TextButton(onClick = { open = true }, enabled = enabled) { Text(stringResource(R.string.connect_paste_open)) }
        return
    }
    OutlinedTextField(
        value = text,
        onValueChange = { text = it },
        label = { Text(stringResource(R.string.connect_paste_label)) },
        minLines = 2,
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedButton(onClick = { onPaste(text) }, enabled = enabled && text.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.connect_paste_claim))
    }
}

@Composable
private fun LoginStep(state: ConnectState, onBack: () -> Unit, onSignIn: (String, String) -> Unit) {
    var username by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Text(stringResource(R.string.term_login), style = MaterialTheme.typography.headlineSmall)
    Text(state.hubName?.let { "$it · ${state.hub}" } ?: state.hub.orEmpty(), color = LocalTokens.current.textMuted)
    OutlinedTextField(
        value = username, onValueChange = { username = it }, singleLine = true,
        label = { Text(stringResource(R.string.connect_username)) }, modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = password, onValueChange = { password = it }, singleLine = true,
        label = { Text(stringResource(R.string.connect_password)) },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
        modifier = Modifier.fillMaxWidth(),
    )
    ErrorNotice(state.error)
    Button(onClick = { onSignIn(username, password) }, enabled = !state.busy && username.isNotBlank() && password.isNotEmpty(), modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.term_login))
    }
    TextButton(onClick = onBack) { Text(stringResource(R.string.connect_other_hub)) }
}

@Composable
private fun SetupStep(state: ConnectState, onBack: () -> Unit, onSetup: (String, String, String, String) -> Unit) {
    var username by rememberSaveable { mutableStateOf("") }
    var displayName by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    Text(stringResource(R.string.term_setup), style = MaterialTheme.typography.headlineSmall)
    Text(
        stringResource(if (state.setupOpen) R.string.setup_open_body else R.string.setup_token_body),
        color = LocalTokens.current.textMuted,
    )
    OutlinedTextField(username, { username = it }, singleLine = true, label = { Text(stringResource(R.string.connect_username)) }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(displayName, { displayName = it }, singleLine = true, label = { Text(stringResource(R.string.setup_display_name)) }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(
        password, { password = it }, singleLine = true, label = { Text(stringResource(R.string.connect_password)) },
        visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        confirm, { confirm = it }, singleLine = true, label = { Text(stringResource(R.string.setup_confirm)) },
        isError = confirm.isNotEmpty() && confirm != password,
        visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
    )
    if (!state.setupOpen) {
        OutlinedTextField(token, { token = it }, singleLine = true, label = { Text(stringResource(R.string.setup_token)) }, modifier = Modifier.fillMaxWidth())
    }
    ErrorNotice(state.error)
    Button(
        onClick = { onSetup(username, displayName, password, token) },
        enabled = !state.busy && username.isNotBlank() && password.isNotEmpty() && password == confirm,
        modifier = Modifier.fillMaxWidth(),
    ) { Text(stringResource(R.string.setup_create)) }
    TextButton(onClick = onBack) { Text(stringResource(R.string.connect_other_hub)) }
}
