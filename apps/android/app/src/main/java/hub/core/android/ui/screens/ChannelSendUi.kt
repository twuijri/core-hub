package hub.core.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hub.core.android.R
import hub.core.android.generated.FontTokens
import hub.core.android.ui.components.Composer
import hub.core.android.ui.components.Notice
import hub.core.android.ui.components.Tone
import hub.core.android.ui.components.errorText
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.ChannelOutgoing
import hub.core.client.model.ChannelSendFailure
import hub.core.client.model.ChannelSendUnavailable

/*
 * The pieces of writing into a channel conversation from the phone (§153), apart from the screen
 * so ChannelSendShots draws them on their own: the bottom of the transcript (the composer, or why
 * not), and a message written from the hub with what became of it. The web's ChannelComposer and
 * HubMessage.
 */

/** Why a channel conversation cannot be written into, in the reader's words. */
@Composable
fun channelUnavailableText(reason: ChannelSendUnavailable, channel: String): String = when (reason) {
    ChannelSendUnavailable.NOT_ADMIN -> stringResource(R.string.chcv_send_unavailable_not_admin, channel)
    ChannelSendUnavailable.PLATFORM_UNSUPPORTED -> stringResource(R.string.chcv_send_unavailable_platform_unsupported, channel)
    ChannelSendUnavailable.HERMES_NOT_MANAGED -> stringResource(R.string.chcv_send_unavailable_hermes_not_managed, channel)
    ChannelSendUnavailable.BRIDGE_OFFLINE -> stringResource(R.string.chcv_send_unavailable_bridge_offline, channel)
    ChannelSendUnavailable.NOT_CURRENT -> stringResource(R.string.chcv_send_unavailable_not_current, channel)
    ChannelSendUnavailable.NO_ROUTE -> stringResource(R.string.chcv_send_unavailable_no_route, channel)
}

/** A refused send in plain words: the channel's own refusal, why the hub would not, or the error. */
@Composable
fun channelSendRefusalText(failure: ChannelSendRefusal, channel: String): String = when (failure) {
    is ChannelSendRefusal.Channel -> stringResource(R.string.chcv_send_error_channel, channel, failure.message)
    is ChannelSendRefusal.Unavailable -> channelUnavailableText(failure.reason, channel)
    is ChannelSendRefusal.Other -> errorText(failure.error)
}

/**
 * Where the composer is: for an admin the composer (the chat's own, without what only a hub chat
 * has — attachments, models, voice), with a refusal above it and a line saying where the words go;
 * otherwise why not, and for a conversation that moved on, the way to the current one. «Continue in
 * Core Hub» (§62) stays in both.
 */
@Composable
fun ChannelSendBottom(
    bottom: ChannelBottom,
    channel: String,
    peer: String,
    draft: String,
    onDraft: (String) -> Unit,
    busy: Boolean,
    failure: ChannelSendRefusal?,
    onSend: () -> Unit,
    onOpenCurrent: (String) -> Unit,
    onContinue: () -> Unit,
) {
    val t = LocalTokens.current
    when (bottom) {
        ChannelBottom.Composer -> Column(Modifier.fillMaxWidth().testTag("channel.composer")) {
            failure?.let {
                Notice(channelSendRefusalText(it, channel), Tone.DANGER, Modifier.padding(horizontal = 12.dp).padding(top = 8.dp).testTag("channel.send.error"))
            }
            Composer(
                text = draft,
                onText = { onDraft(it.take(ChannelSendRules.TEXT_MAX)) },
                placeholder = stringResource(R.string.chcv_send_placeholder, channel, peer),
                running = false,
                sending = busy,
                onSend = onSend,
                onStop = {},
                sendLabel = stringResource(R.string.chcv_send_send, channel),
            )
            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    stringResource(R.string.chcv_send_hint, channel), fontSize = FontTokens.sizeXs.sp, color = t.textMuted,
                    modifier = Modifier.weight(1f).testTag("channel.send.hint"),
                )
                HubButton(
                    stringResource(R.string.chcv_continue_button), onContinue, kind = ButtonKind.Secondary, size = ControlSize.Sm,
                    icon = Lucide.MessagesSquare, modifier = Modifier.testTag("channel.continue"),
                )
            }
        }
        else -> Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val text = when (bottom) {
                is ChannelBottom.Unavailable -> channelUnavailableText(bottom.reason, channel)
                else -> stringResource(R.string.chcv_readonly_banner, channel, channel)
            }
            Notice(text, Tone.INFO, Modifier.testTag("channel.readonly"))
            val current = (bottom as? ChannelBottom.Unavailable)?.currentId
            if (current != null) {
                HubButton(
                    stringResource(R.string.chcv_send_open_current), { onOpenCurrent(current) }, kind = ButtonKind.Secondary, size = ControlSize.Md,
                    icon = Lucide.CornerDownRight, modifier = Modifier.testTag("channel.open_current"),
                )
            }
            HubButton(
                stringResource(R.string.chcv_continue_button), onContinue, size = ControlSize.Md, icon = Lucide.MessagesSquare,
                modifier = Modifier.testTag("channel.continue"),
            )
        }
    }
}

/**
 * A message written from the hub: on the owner's side, as the person's bubble, named «<name> ·
 * from Core Hub» (no name yet: «You · from Core Hub»). [status] is what became of it — shown when
 * [followed] (the hub still follows it, or it is on its way: `null` status then means «Sending…»).
 */
@Composable
fun HubMessageView(name: String?, text: String, channel: String, followed: Boolean, status: ChannelOutgoing?) {
    val t = LocalTokens.current
    Column(Modifier.fillMaxWidth().testTag("channel.message.hub"), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            if (name != null) stringResource(R.string.chcv_send_from_hub, name) else stringResource(R.string.chcv_send_you),
            fontSize = FontTokens.sizeXs.sp, fontWeight = FontWeight.Medium, color = t.textMuted,
            style = TextStyle(textDirection = TextDirection.Content),
        )
        Column(
            Modifier.widthIn(max = 320.dp).background(t.userBubble, RoundedCornerShape(16.dp)).border(1.dp, t.userBubbleBorder, RoundedCornerShape(16.dp))
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(text, fontSize = FontTokens.sizeMd.sp, color = t.userBubbleText, style = TextStyle(textDirection = TextDirection.Content))
        }
        if (followed) OutgoingStatusLine(status, channel)
    }
}

/** What became of a message written from the hub, in a line under it; nothing once answered. */
@Composable
private fun OutgoingStatusLine(status: ChannelOutgoing?, channel: String) {
    val t = LocalTokens.current
    if (status?.status == ChannelOutgoing.Status.ANSWERED) return
    val failed = status?.status == ChannelOutgoing.Status.FAILED
    val text = when (status?.status) {
        null -> stringResource(R.string.chcv_send_status_sending, channel)
        ChannelOutgoing.Status.POSTED -> stringResource(R.string.chcv_send_status_posted, channel)
        ChannelOutgoing.Status.DELIVERED -> stringResource(R.string.chcv_send_status_delivered)
        ChannelOutgoing.Status.ANSWERING -> stringResource(R.string.chcv_send_status_answering, channel)
        ChannelOutgoing.Status.ANSWERED -> ""
        ChannelOutgoing.Status.FAILED -> {
            val why = when (status.error?.reason) {
                ChannelSendFailure.Reason.BRIDGE_NO_ANSWER -> stringResource(R.string.chcv_send_failed_bridge_no_answer, channel)
                ChannelSendFailure.Reason.NOT_ACCEPTED -> stringResource(R.string.chcv_send_failed_not_accepted, channel)
                ChannelSendFailure.Reason.NOT_PICKED_UP, null -> stringResource(R.string.chcv_send_failed_not_picked_up, channel)
            }
            status.error?.message?.takeIf { it.isNotBlank() }?.let { "$why ($it)" } ?: why
        }
    }
    Text(
        text, fontSize = FontTokens.sizeXs.sp, color = if (failed) t.danger else t.textMuted,
        style = TextStyle(textDirection = TextDirection.Content),
        modifier = Modifier.widthIn(max = 320.dp).semantics { liveRegion = LiveRegionMode.Polite }
            .testTag("channel.outgoing.${status?.status?.value ?: "sending"}"),
    )
}
