package hub.core.android.ui.screens

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.chat.Outgoing
import hub.core.android.data.HubError
import hub.core.android.generated.FontTokens
import hub.core.android.graph
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.MarkdownView
import hub.core.android.ui.components.Notice
import hub.core.android.ui.components.Tone
import hub.core.android.ui.components.rememberAgents
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ConfirmDialog
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.EmptyState
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubDialog
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubMenu
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.MenuDivider
import hub.core.android.ui.kit.MenuItem
import hub.core.android.ui.kit.Spinner
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.ChannelAttachment
import hub.core.client.model.ChannelConversation
import hub.core.client.model.ChannelMessage
import hub.core.client.model.ChannelOutgoing
import hub.core.client.model.ContentBlock
import kotlinx.coroutines.channels.Channel as KChannel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/*
 * A conversation held on Telegram, WhatsApp… as Hermes keeps it (contract decision §61), in the
 * chat's own look — the person on the channel on one side, the agent's replies on the other. An
 * admin may write into a Telegram or WhatsApp one from here (§153): the composer posts on the
 * channel first, as «من كور هب (<name>): …», then the agent answers there; the words show at once
 * with what became of them, and the reply appears when the agent's turn ends (ChannelSend.kt).
 * Where it cannot be written into, the composer's place says why, and «Continue in Core Hub» (§62)
 * carries it into a new hub chat with the transcript attached. The conversation stays the
 * channel's: same label, same group in the list. Older messages are read a page at a time (§103),
 * pictures the person sent are drawn while Hermes keeps them, and the transcript is read again as
 * the hub announces each turn (`channel_conversation.updated`), with a poll as the fallback —
 * every half minute on an older hub. The web's ChannelConversationView; native on the phone since
 * 2026-09-27.
 */

/** The platform's name in the reader's language: Telegram and WhatsApp translated, others as they are. */
@Composable
fun channelName(platform: String): String = when (platform) {
    "telegram" -> stringResource(R.string.chcv_telegram)
    "whatsapp" -> stringResource(R.string.chcv_whatsapp)
    else -> platform
}

/** A row's title: the other party, else Hermes's title or the party's id, else «A Telegram conversation». */
@Composable
fun conversationTitle(conversation: ChannelConversation): String =
    ChatGroupsRules.title(conversation) ?: stringResource(R.string.chcv_untitled, channelName(conversation.channel))

/** Merges the pages read before the latest one (oldest first) with the latest, dropping repeats. */
object ChannelTranscript {
    fun merge(older: List<ChannelMessage>, latest: List<ChannelMessage>): List<ChannelMessage> {
        val seen = latest.map { it.id }.toSet()
        return older.filter { it.id !in seen } + latest
    }
}

@Composable
fun ChannelChatScreen(
    conversationId: String,
    profile: String,
    shell: ShellViewModel,
    onMenu: () -> Unit,
    onOpenChat: (sessionId: String, profile: String) -> Unit,
    onGone: () -> Unit,
    subtitleProfile: String?,
    /** Another channel conversation: the current one of this chat, where a message from here would go (§153). */
    onOpenConversation: (conversationId: String, profile: String) -> Unit = { _, _ -> },
) {
    val t = LocalTokens.current
    val graph = LocalContext.current.graph
    val ops = shell.extras.ops
    val scope = rememberCoroutineScope()
    val isAdmin = graph.store.current?.user?.isAdmin == true
    var conversation by remember(conversationId) { mutableStateOf<ChannelConversation?>(null) }
    var latest by remember(conversationId) { mutableStateOf<List<ChannelMessage>>(emptyList()) }
    var older by remember(conversationId) { mutableStateOf<List<ChannelMessage>>(emptyList()) }
    var nextOffset by remember(conversationId) { mutableStateOf<Int?>(null) }
    var hasMore by remember(conversationId) { mutableStateOf(false) }
    var olderRead by remember(conversationId) { mutableStateOf(false) }
    var loading by remember(conversationId) { mutableStateOf(true) }
    var loadingOlder by remember(conversationId) { mutableStateOf(false) }
    var error by remember(conversationId) { mutableStateOf<HubError?>(null) }
    var menu by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var continuing by remember { mutableStateOf(false) }
    // What the hub's people wrote from here and the hub still follows (§153), and whether the hub
    // announces each turn itself (then the poll below is only a slow fallback).
    var outgoing by remember(conversationId) { mutableStateOf<List<ChannelOutgoing>>(emptyList()) }
    var liveUpdates by remember(conversationId) { mutableStateOf(false) }
    var draft by remember(conversationId) { mutableStateOf("") }
    var sending by remember(conversationId) { mutableStateOf<ChannelSending?>(null) }
    var refusal by remember(conversationId) { mutableStateOf<ChannelSendRefusal?>(null) }
    // Read again now (an announced turn, a refused send) instead of at the next poll.
    val again = remember(conversationId) { KChannel<Unit>(KChannel.CONFLATED) }
    LaunchedEffect(conversationId, profile) {
        while (isActive) {
            ops.messages(profile, conversationId).onSuccess { page ->
                conversation = page.conversation
                latest = page.items
                outgoing = page.outgoing.orEmpty()
                liveUpdates = page.liveUpdates == true
                if (!olderRead) { nextOffset = page.nextOffset; hasMore = page.hasMore }
                error = null
            }.onFailure { error = it as HubError }
            loading = false
            withTimeoutOrNull(ChannelSendRules.transcriptPollMs(liveUpdates)) { again.receive() }
        }
    }
    // `channel_conversation.updated` (§153): the message's state moves in place; a turn that began
    // or ended, or the message's end, reads the transcript again.
    LaunchedEffect(conversationId) {
        graph.realtime.events.collect { envelope ->
            val update = ChannelSendRules.parse(envelope) ?: return@collect
            val applied = ChannelSendRules.apply(conversationId, outgoing, update)
            outgoing = applied.outgoing
            if (applied.refetch) again.trySend(Unit)
        }
    }
    val send: () -> Unit = send@{
        val words = ChannelSendRules.words(draft) ?: return@send
        if (sending != null) return@send
        val key = ChannelSendRules.clientId()
        refusal = null
        draft = ""
        sending = ChannelSending(key, words)
        scope.launch {
            ops.send(profile, conversationId, words, key)
                .onSuccess { made -> outgoing = ChannelSendRules.upsert(outgoing, made) }
                .onFailure { e ->
                    // Nothing reached the agent: the words go back where they were typed.
                    if (draft.isBlank()) draft = words
                    val why = ChannelSendRules.failure(e as HubError)
                    refusal = why
                    // The hub's reason may be news (the chat moved on, the gateway stopped): the bottom follows.
                    if (why is ChannelSendRefusal.Unavailable) again.trySend(Unit)
                }
            sending = null
        }
    }
    val messages = ChannelTranscript.merge(older, latest)
    val split = ChannelSendRules.split(messages, outgoing)
    val showSending = ChannelSendRules.showSending(sending, split.pending)
    val peer = conversation?.let { conversationTitle(it) } ?: term("chat")
    val channel = conversation?.let { channelName(it.channel) }.orEmpty()
    Column(Modifier.fillMaxSize().testTag("channel.screen")) {
        TopBar(peer, onMenu = onMenu, subtitle = listOfNotNull(channel.ifEmpty { null }, subtitleProfile).joinToString(" · ").ifEmpty { null }) {
            val c = conversation
            if (c != null) {
                Box {
                    HubIconButton(Lucide.Ellipsis, stringResource(R.string.chcv_actions), { menu = true }, modifier = Modifier.testTag("channel.actions"))
                    HubMenu(menu, { menu = false }) {
                        if (c.hidden == true) {
                            MenuItem(stringResource(R.string.chcv_unhide), { menu = false; shell.extras.write({ it.unhide(c) }) }, icon = Lucide.Eye)
                        } else {
                            MenuItem(
                                stringResource(R.string.chcv_hide),
                                { menu = false; shell.extras.write({ it.hide(c) }, after = onGone) },
                                Modifier.testTag("channel.hide"), icon = Lucide.EyeOff,
                            )
                        }
                        if (isAdmin) {
                            MenuDivider()
                            MenuItem(stringResource(R.string.chcv_delete), { menu = false; deleting = true }, Modifier.testTag("channel.delete"), icon = Lucide.Trash, danger = true)
                        }
                    }
                }
            }
        }
        conversation?.title?.takeIf { it != peer }?.let {
            Text(it, fontSize = FontTokens.sizeSm.sp, color = t.textMuted, modifier = Modifier.padding(horizontal = 16.dp), style = TextStyle(textDirection = TextDirection.Content))
        }
        val list = rememberLazyListState()
        val rows = messages.size + split.pending.size + (if (showSending) 1 else 0)
        // To the end (the list clamps an index past its last row, the header rows included).
        LaunchedEffect(latest.size, split.pending.size, showSending) { if (rows > 0 && !loadingOlder) list.scrollToItem(rows + 4) }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth().testTag("channel.transcript"), state = list,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (loading) item { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { Spinner(20.dp, t.textMuted) } }
            if (hasMore) {
                item(key = "older") {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        val offset = nextOffset
                        if (offset != null) {
                            HubButton(
                                stringResource(R.string.chcv_load_older),
                                {
                                    loadingOlder = true
                                    scope.launch {
                                        ops.messages(profile, conversationId, offset).onSuccess { page ->
                                            older = page.items + older
                                            olderRead = true
                                            nextOffset = page.nextOffset
                                            hasMore = page.nextOffset != null
                                        }.onFailure { error = it as HubError }
                                        loadingOlder = false
                                    }
                                },
                                kind = ButtonKind.Secondary, size = ControlSize.Sm, loading = loadingOlder, modifier = Modifier.testTag("channel.older"),
                            )
                        } else {
                            Text(stringResource(R.string.chcv_has_more), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                        }
                    }
                }
            }
            error?.let { item(key = "error") { ErrorNotice(it) } }
            if (!loading && messages.isEmpty() && error == null) {
                item(key = "empty") { EmptyState(stringResource(R.string.chcv_no_messages), icon = Lucide.Globe) }
            }
            items(messages, key = { it.id }) { message ->
                if (ChannelSendRules.fromHub(message)) {
                    val followed = split.followed[message.id]
                    HubMessageView(message.authorName, message.text, channel, followed = followed != null, status = followed)
                } else {
                    ChannelMessageView(message, peer, conversationId, profile, ops)
                }
            }
            // Written from here and not in the transcript yet: after the rest, with what became of it.
            items(split.pending, key = { "outgoing:${it.id}" }) { each -> HubMessageView(each.authorName, each.text, channel, followed = true, status = each) }
            sending?.takeIf { showSending }?.let { words ->
                item(key = "sending:${words.key}") { HubMessageView(null, words.text, channel, followed = true, status = null) }
            }
        }
        val c = conversation
        if (c != null) {
            ChannelSendBottom(
                ChannelSendRules.bottom(c), channel, peer, draft, onDraft = { draft = it }, busy = sending != null, failure = refusal,
                onSend = send, onOpenCurrent = { id -> onOpenConversation(id, c.profile) }, onContinue = { continuing = true },
            )
        }
    }
    val c = conversation
    if (deleting && c != null) {
        ConfirmDialog(
            title = stringResource(R.string.chcv_delete_title, conversationTitle(c)),
            body = stringResource(R.string.chcv_delete_body, channel),
            confirm = stringResource(R.string.chcv_delete_confirm),
            onConfirm = { deleting = false; shell.extras.write({ it.delete(c) }, after = onGone) },
            onDismiss = { deleting = false },
            danger = true,
        )
    }
    if (continuing && c != null) {
        ContinueDialog(c, channel, shell, onDismiss = { continuing = false }, onOpenChat = onOpenChat)
    }
}

/** «Continue in Core Hub»: a new chat in this profile with the conversation attached, and its first message sent. */
@Composable
private fun ContinueDialog(
    conversation: ChannelConversation,
    channel: String,
    shell: ShellViewModel,
    onDismiss: () -> Unit,
    onOpenChat: (sessionId: String, profile: String) -> Unit,
) {
    val graph = LocalContext.current.graph
    val scope = rememberCoroutineScope()
    val agents = rememberAgents(conversation.profile)
    val agent = ChatGroupsRules.continueAgent(agents)
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<HubError?>(null) }
    HubDialog({ if (!busy) onDismiss() }, stringResource(R.string.chcv_continue_title)) {
        Text(stringResource(R.string.chcv_continue_hint, channel), fontSize = FontTokens.sizeSm.sp, color = LocalTokens.current.textMuted)
        HubTextField(
            note, { note = it }, Modifier.fillMaxWidth(), label = stringResource(R.string.chcv_continue_note),
            singleLine = false, minLines = 3, size = ControlSize.Md, fieldTag = "channel.continue.note",
        )
        if (agents.isNotEmpty() && agent == null) Notice(stringResource(R.string.chcv_continue_no_agent), Tone.WARNING)
        ErrorNotice(error)
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            HubButton(stringResource(R.string.cancel), onDismiss, kind = ButtonKind.Secondary, size = ControlSize.Md, enabled = !busy)
            HubButton(
                stringResource(R.string.chcv_continue_go),
                {
                    val a = agent ?: return@HubButton
                    busy = true
                    scope.launch {
                        shell.extras.ops.continueIn(conversation.profile, conversation.id, a.id, note)
                            .onSuccess { made ->
                                // The first message goes out once the chat listens, as a typed one does.
                                val text = made.firstMessage.firstOrNull { it.type == ContentBlock.Type.TEXT }?.text.orEmpty()
                                graph.outbox[made.session.id] = Outgoing(text, raw = made.firstMessage)
                                shell.reloadChats()
                                onDismiss()
                                onOpenChat(made.session.id, made.session.profile)
                            }
                            .onFailure { error = it as HubError; busy = false }
                    }
                },
                size = ControlSize.Md, loading = busy, enabled = agent != null, modifier = Modifier.testTag("channel.continue.go"),
            )
        }
    }
}

/** One message: the person on the channel as a bubble, the agent's reply as the chat draws it. */
@Composable
private fun ChannelMessageView(message: ChannelMessage, peer: String, conversationId: String, profile: String, ops: ChatGroupsOps) {
    val t = LocalTokens.current
    val pictures = message.attachments.orEmpty()
    if (message.role == ChannelMessage.Role.USER) {
        Column(Modifier.fillMaxWidth().testTag("channel.message.user"), horizontalAlignment = Alignment.End) {
            Text(peer, fontSize = FontTokens.sizeXs.sp, color = t.textMuted, style = TextStyle(textDirection = TextDirection.Content))
            Column(
                Modifier.widthIn(max = 320.dp).background(t.userBubble, RoundedCornerShape(16.dp)).border(1.dp, t.userBubbleBorder, RoundedCornerShape(16.dp))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                pictures.forEach { ChannelPicture(it, conversationId, profile, ops) }
                if (message.text.isNotEmpty()) {
                    Text(message.text, fontSize = FontTokens.sizeMd.sp, color = t.userBubbleText, style = TextStyle(textDirection = TextDirection.Content))
                }
            }
        }
    } else {
        Column(Modifier.fillMaxWidth().testTag("channel.message.agent"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.chcv_assistant), fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.Medium, color = t.textMuted)
            pictures.forEach { ChannelPicture(it, conversationId, profile, ops) }
            MarkdownView(message.text)
        }
    }
}

/** A picture the person sent on the channel, read with the person's own credentials; a gone one says so. */
@Composable
private fun ChannelPicture(attachment: ChannelAttachment, conversationId: String, profile: String, ops: ChatGroupsOps) {
    val t = LocalTokens.current
    if (!attachment.available) {
        Text(stringResource(R.string.chcv_picture_gone), fontSize = FontTokens.sizeXs.sp, color = t.textMuted, modifier = Modifier.testTag("channel.picture.gone"))
        return
    }
    val bitmap by produceState<android.graphics.Bitmap?>(null, attachment.id) {
        value = ops.picture(profile, conversationId, attachment.id).getOrNull()?.let { file ->
            runCatching { BitmapFactory.decodeFile(file.absolutePath) }.getOrNull().also { file.delete() }
        }
    }
    val b = bitmap
    if (b == null) {
        Box(Modifier.widthIn(min = 120.dp).heightIn(min = 80.dp), contentAlignment = Alignment.Center) { Spinner(16.dp, t.textMuted) }
    } else {
        Image(
            b.asImageBitmap(), stringResource(R.string.chcv_picture),
            Modifier.widthIn(max = 280.dp).heightIn(max = 320.dp).testTag("channel.picture"), contentScale = ContentScale.Fit,
        )
    }
}
