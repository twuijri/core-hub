package hub.core.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.chat.ChatControls
import hub.core.android.chat.ChatMessage
import hub.core.android.generated.ControlTokens
import hub.core.android.generated.FontTokens
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubDialog
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.LucideIcon
import hub.core.android.ui.kit.MenuLabel
import hub.core.android.ui.screens.ChatNotice
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Choice
import hub.core.client.model.WorkingDirs

/**
 * The chat controls' views (apps batch 1), as on iOS: compact chips just above the composer (a new
 * chat's folder, the model, the approvals, and Steer while a reply runs), each opening a sheet —
 * a phone has no room for the web's popovers, and a sheet has room for what each choice means.
 */
@Composable
fun ComposerChips(
    models: List<ChatControls.ModelOption>,
    modelsLoaded: Boolean,
    model: String?,
    onModel: (String?) -> Unit,
    approval: ChatControls.ApprovalField?,
    isAdmin: Boolean,
    onApproval: (String) -> Unit,
    modifier: Modifier = Modifier,
    /** A new chat may keep the agent's default; a chat that has one cannot go back to it. */
    allowDefault: Boolean = false,
    /** Which model «Default» is, when the hub says: «Default · <model>» (ADR 0029). */
    defaultModelName: String? = null,
    /** A new chat's folder: shown only when [onFolder] is given (a chat's folder is fixed once it ran). */
    folder: String? = null,
    dirs: WorkingDirs? = null,
    dirsError: String? = null,
    onFolder: ((String?) -> Unit)? = null,
    /** Shown while a reply runs and the agent can be steered; ready once words are typed. */
    onSteer: (() -> Unit)? = null,
    steerReady: Boolean = false,
) {
    var sheet by remember { mutableStateOf<String?>(null) }
    val defaultLabel = defaultModelName?.let { stringResource(R.string.chat_controls_model_default_named, it) }
        ?: stringResource(R.string.chat_controls_model_default)
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 2.dp).testTag("composer.chips"),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onFolder != null) {
            ControlChip(
                Lucide.Folder, ChatControls.folderName(folder, dirs?.root) ?: stringResource(R.string.chat_controls_folder_automatic),
                stringResource(R.string.chat_controls_folder), "composer.folder",
            ) { sheet = "folder" }
        }
        ControlChip(
            Lucide.Cpu, ChatControls.modelLabel(model, models) ?: defaultLabel,
            stringResource(R.string.chat_controls_model), "composer.model",
        ) { sheet = "model" }
        if (approval != null) {
            val risky = ChatControls.risky(approval.value)
            ControlChip(
                if (risky) Lucide.TriangleAlert else Lucide.ShieldCheck, approvalTitle(approval.value, approval.options),
                stringResource(R.string.chat_controls_approval), "composer.approvals", warning = risky,
            ) { sheet = "approvals" }
        }
        if (onSteer != null) {
            ControlChip(
                Lucide.CornerDownRight, stringResource(R.string.chat_controls_steer), stringResource(R.string.chat_controls_steer_hint),
                "composer.steer", chevron = false, accent = steerReady, enabled = steerReady, onClick = onSteer,
            )
        }
    }
    when (sheet) {
        "model" -> ModelPickerSheet(
            models, modelsLoaded, model, allowDefault, onChoose = { onModel(it); sheet = null }, onDismiss = { sheet = null },
            defaultLabel = defaultLabel,
        )
        "approvals" -> if (approval != null) {
            ApprovalSheet(approval, isAdmin, onChoose = { onApproval(it); sheet = null }, onDismiss = { sheet = null })
        }
        "folder" -> if (onFolder != null) {
            WorkingDirSheet(dirs, dirsError, folder, onChoose = { onFolder(it); sheet = null }, onDismiss = { sheet = null })
        }
    }
}

@Composable
private fun ControlChip(
    icon: Int,
    text: String,
    label: String,
    tag: String,
    chevron: Boolean = true,
    warning: Boolean = false,
    accent: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val t = LocalTokens.current
    Row(
        Modifier.height(ControlTokens.heightSm.dp).clip(CircleShape)
            .background(if (accent) t.accentSoft else t.surface, CircleShape)
            .border(1.dp, if (accent) t.accent else t.border, CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = label, onClick = onClick)
            .semantics { contentDescription = "$label: $text" }
            .padding(horizontal = 10.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        LucideIcon(icon, null, size = 13.dp, tint = if (warning) t.warningSoftText else if (accent) t.accentSoftText else t.textMuted)
        Text(
            text, fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.Medium,
            color = if (!enabled) t.textFaint else if (accent) t.accentSoftText else t.text,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp),
        )
        if (chevron) LucideIcon(Lucide.ChevronDown, null, size = 10.dp, tint = t.textFaint)
    }
}

/** A row of a chooser sheet: the words, a quiet line under them, and a check when it is the choice. */
@Composable
private fun ChoiceRow(title: String, detail: String?, checked: Boolean, enabled: Boolean = true, warning: Boolean = false, tag: String? = null, onClick: () -> Unit) {
    val t = LocalTokens.current
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).clip(hub.core.android.ui.kit.ItemShape)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { selected = checked }
            .padding(horizontal = 8.dp, vertical = 8.dp)
            .then(if (tag != null) Modifier.testTag(tag) else Modifier),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (warning) LucideIcon(Lucide.TriangleAlert, null, size = 14.dp, tint = t.warningSoftText)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, fontSize = FontTokens.sizeMd.sp, color = if (enabled) t.text else t.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (!detail.isNullOrBlank()) Text(detail, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        if (checked) LucideIcon(Lucide.Check, null, size = 16.dp, tint = t.accent)
    }
}

/** The profile's chat models, searchable and grouped by provider. */
@Composable
fun ModelPickerSheet(
    options: List<ChatControls.ModelOption>,
    loaded: Boolean,
    current: String?,
    allowDefault: Boolean,
    onChoose: (String?) -> Unit,
    onDismiss: () -> Unit,
    /** The «Default» row's words (which model it is, when known). */
    defaultLabel: String? = null,
) {
    val t = LocalTokens.current
    var query by remember { mutableStateOf("") }
    val shown = ChatControls.filter(options, query)
    HubSheet(onDismiss, Modifier.testTag("sheet.model"), title = stringResource(R.string.chat_controls_model_title)) {
        HubTextField(
            query, { query = it }, placeholder = stringResource(R.string.chat_controls_model_search), leadingIcon = Lucide.Search,
            size = ControlSize.Md, modifier = Modifier.fillMaxWidth(), fieldTag = "model.search",
        )
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp)) {
            if (allowDefault && query.isBlank()) {
                item(key = "default") {
                    ChoiceRow(
                        defaultLabel ?: stringResource(R.string.chat_controls_model_default), stringResource(R.string.chat_controls_model_default_hint),
                        current == null, tag = "model.default",
                    ) { onChoose(null) }
                }
            }
            when {
                !loaded -> item(key = "loading") { SheetSpinner() }
                options.isEmpty() -> item(key = "none") { Text(stringResource(R.string.chat_controls_model_none), color = t.textMuted, fontSize = FontTokens.sizeSm.sp) }
                shown.isEmpty() -> item(key = "nomatch") { Text(stringResource(R.string.chat_controls_model_no_match), color = t.textMuted, fontSize = FontTokens.sizeSm.sp) }
            }
            ChatControls.groups(shown).forEach { (group, items) ->
                item(key = "group:$group") { MenuLabel(group) }
                items(items, key = { it.value }) { option ->
                    // The id under the name, and «small context» under the agent's floor (§141).
                    val small = option.smallUnder?.let { stringResource(R.string.chat_controls_model_small_context, (it / 1000).toString()) }
                    val detail = listOfNotNull(option.value.takeIf { it != option.label }, small).joinToString(" · ").ifEmpty { null }
                    ChoiceRow(option.label, detail, option.value == current, tag = "model.${option.value}") {
                        onChoose(option.value)
                    }
                }
            }
        }
    }
}

@Composable
private fun SheetSpinner() = Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.Center) {
    hub.core.android.ui.kit.Spinner(18.dp, LocalTokens.current.textMuted)
}

/** Our words for the approval modes we know; the adapter's own label (in the app's language) for any other. */
@Composable
fun approvalTitle(value: String, options: List<Choice>): String {
    approvalTitleRes(value)?.let { return stringResource(it) }
    val option = options.firstOrNull { it.value == value } ?: return value
    val arabic = androidx.compose.ui.platform.LocalConfiguration.current.locales[0].language == "ar"
    return option.labels?.let { if (arabic) it.ar else it.en } ?: option.label
}

fun approvalTitleRes(value: String): Int? = when (value) {
    "ask" -> R.string.chat_controls_approval_mode_ask
    "auto_safe" -> R.string.chat_controls_approval_mode_auto_safe
    "auto_all" -> R.string.chat_controls_approval_mode_auto_all
    "off" -> R.string.chat_controls_approval_mode_off
    "always" -> R.string.chat_controls_approval_mode_always
    "manual" -> R.string.chat_controls_approval_mode_manual
    "smart" -> R.string.chat_controls_approval_mode_smart
    else -> null
}

fun approvalHintRes(value: String): Int? = when (value) {
    "ask" -> R.string.chat_controls_approval_hint_ask
    "auto_safe" -> R.string.chat_controls_approval_hint_auto_safe
    "auto_all" -> R.string.chat_controls_approval_hint_auto_all
    "off" -> R.string.chat_controls_approval_hint_off
    "always" -> R.string.chat_controls_approval_hint_always
    "manual" -> R.string.chat_controls_approval_hint_manual
    "smart" -> R.string.chat_controls_approval_hint_smart
    else -> null
}

/**
 * The agent's approval modes, each with what it changes (owner, 2026-09-22: the difference must be
 * said). Only an admin changes it; it applies to every chat with the agent in this profile.
 */
@Composable
fun ApprovalSheet(field: ChatControls.ApprovalField, isAdmin: Boolean, onChoose: (String) -> Unit, onDismiss: () -> Unit) {
    val t = LocalTokens.current
    HubSheet(onDismiss, Modifier.testTag("sheet.approvals"), title = stringResource(R.string.chat_controls_approval)) {
        field.options.forEach { option ->
            ChoiceRow(
                approvalTitle(option.value, field.options), approvalHintRes(option.value)?.let { stringResource(it) },
                option.value == field.value, enabled = isAdmin, warning = ChatControls.risky(option.value), tag = "approval.${option.value}",
            ) { onChoose(option.value) }
        }
        Text(
            stringResource(if (isAdmin) R.string.chat_controls_approval_applies else R.string.chat_controls_approval_admin),
            fontSize = FontTokens.sizeXs.sp, color = t.textMuted, modifier = Modifier.padding(horizontal = 8.dp),
        )
    }
}

/** A new chat's working folder: automatic, one under the hub's root, or a new name. */
@Composable
fun WorkingDirSheet(dirs: WorkingDirs?, error: String?, current: String?, onChoose: (String?) -> Unit, onDismiss: () -> Unit) {
    val t = LocalTokens.current
    var name by remember { mutableStateOf("") }
    HubSheet(onDismiss, Modifier.testTag("sheet.folder"), title = stringResource(R.string.chat_controls_folder)) {
        dirs?.root?.let {
            Text(it, fontSize = FontTokens.sizeXs.sp, color = t.textFaint, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, maxLines = 2)
        }
        Text(error ?: stringResource(R.string.chat_controls_folder_hint), fontSize = FontTokens.sizeXs.sp, color = if (error != null) t.danger else t.textMuted)
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 320.dp)) {
            item(key = "auto") {
                ChoiceRow(
                    stringResource(R.string.chat_controls_folder_automatic), stringResource(R.string.chat_controls_folder_automatic_note),
                    current == null, tag = "folder.auto",
                ) { onChoose(null) }
            }
            if (dirs == null && error == null) item(key = "loading") { SheetSpinner() }
            items(dirs?.items.orEmpty(), key = { it.path }) { item ->
                val title = if (ChatControls.isGenerated(item.name)) stringResource(R.string.chat_controls_folder_automatic) else item.name
                ChoiceRow(title, null, current == item.path, tag = "folder.item") { onChoose(item.path) }
            }
        }
        MenuLabel(stringResource(R.string.chat_controls_folder_new))
        val valid = ChatControls.newFolder(name)
        HubTextField(
            name, { name = it }, placeholder = stringResource(R.string.chat_controls_folder_new_placeholder), mono = true,
            size = ControlSize.Md, modifier = Modifier.fillMaxWidth(), fieldTag = "folder.new",
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
            error = if (name.isNotBlank() && valid == null) stringResource(R.string.chat_controls_folder_bad_name) else null,
        )
        HubButton(
            stringResource(R.string.chat_controls_folder_use), { valid?.let(onChoose) }, enabled = valid != null,
            kind = ButtonKind.Secondary, size = ControlSize.Md, modifier = Modifier.fillMaxWidth().testTag("folder.use"),
        )
    }
}

/** «Chat name» with the title in a field, Cancel and Save; an empty name does not save. */
@Composable
fun RenameDialog(initial: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var typed by remember(initial) { mutableStateOf(initial) }
    HubDialog(onDismiss, stringResource(R.string.chat_controls_rename_title)) {
        HubTextField(typed, { typed = it }, modifier = Modifier.fillMaxWidth(), size = ControlSize.Md, fieldTag = "rename.field")
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            HubButton(stringResource(R.string.cancel), onDismiss, kind = ButtonKind.Secondary, size = ControlSize.Md)
            HubButton(
                stringResource(R.string.chat_controls_save), { ChatControls.renameTitle(typed)?.let(onSave) },
                enabled = ChatControls.renameTitle(typed) != null, size = ControlSize.Md, modifier = Modifier.testTag("rename.save"),
            )
        }
    }
}

/** What one message offers in a chat (not in a room): read aloud, reply, fork from here; copy is always there. */
data class MessageActions(
    val speak: ((ChatMessage) -> Unit)? = null,
    val reply: ((ChatMessage) -> Unit)? = null,
    val fork: ((ChatMessage) -> Unit)? = null,
)

/** Provided by the chat screen; `null` in a room, whose messages keep only Copy. */
val LocalMessageActions = staticCompositionLocalOf<MessageActions?> { null }

/** The menu items of a message (a long press on yours, «…» under a reply). */
@Composable
fun MessageActionItems(message: ChatMessage, actions: MessageActions, copy: (() -> Unit)?, close: () -> Unit) {
    if (copy != null) hub.core.android.ui.kit.MenuItem(stringResource(R.string.chat_controls_copy), { copy(); close() }, icon = Lucide.Copy)
    if (actions.speak != null && message.role == hub.core.client.model.MessageRole.ASSISTANT) {
        hub.core.android.ui.kit.MenuItem(stringResource(R.string.chat_controls_speak), { actions.speak.invoke(message); close() }, icon = Lucide.Volume2)
    }
    actions.reply?.let { reply ->
        hub.core.android.ui.kit.MenuItem(stringResource(R.string.chat_controls_reply), { reply(message); close() }, icon = Lucide.Reply, modifier = Modifier.testTag("message.reply"))
    }
    actions.fork?.let { fork ->
        hub.core.android.ui.kit.MenuItem(stringResource(R.string.chat_controls_fork_here), { fork(message); close() }, icon = Lucide.GitFork, modifier = Modifier.testTag("message.fork"))
    }
}

/** Over the composer while replying: the words replied to, and a cross that drops the reply. */
@Composable
fun ReplyStrip(message: ChatMessage, onCancel: () -> Unit) {
    val t = LocalTokens.current
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("composer.reply"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LucideIcon(Lucide.Reply, null, size = 14.dp, tint = t.accent)
        Text(
            stringResource(R.string.chat_controls_replying_to, message.text.take(80)), fontSize = FontTokens.sizeXs.sp, color = t.textMuted,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        HubIconButton(Lucide.X, stringResource(R.string.chat_controls_cancel_reply), onCancel, size = ControlTokens.heightSm.dp, iconSize = 14.dp)
    }
}

/** The words for what the last compress or steer did. */
@Composable
fun noticeText(notice: ChatNotice): String = when (notice) {
    ChatNotice.Compressing -> stringResource(R.string.chat_controls_compressing)
    ChatNotice.Steered -> stringResource(R.string.chat_controls_steered)
    ChatNotice.SteerQueued -> stringResource(R.string.chat_controls_steer_queued)
    is ChatNotice.NeedsWords -> stringResource(R.string.slash_needs_argument, "/" + notice.command)
    is ChatNotice.UnknownModel -> stringResource(R.string.slash_model_unknown, notice.model)
    is ChatNotice.Compressed -> when (val outcome = notice.outcome) {
        is ChatControls.Compression.Compressed ->
            if (outcome.before != null && outcome.after != null) {
                stringResource(R.string.chat_controls_compressed, outcome.before.toString(), outcome.after.toString())
            } else {
                stringResource(R.string.chat_controls_compressed_plain)
            }
        ChatControls.Compression.Unchanged -> stringResource(R.string.chat_controls_compress_unchanged)
        ChatControls.Compression.Skipped -> stringResource(R.string.chat_controls_compress_skipped)
    }
}

/** The line a chat shows for an action's outcome: a quiet notice, tap to put it away. */
@Composable
fun ChatNoticeLine(notice: ChatNotice, onDismiss: () -> Unit) {
    Notice(noticeText(notice), Tone.INFO, Modifier.clickable(onClick = onDismiss).testTag("chat.notice"))
}
