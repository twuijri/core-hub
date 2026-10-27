package hub.core.android.ui.components

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import hub.core.android.R
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.IconKind
import hub.core.android.ui.kit.Lucide

/**
 * Whether the reader has scrolled up from the newest message: the last row of [list] is not on
 * screen at all. A reply growing under a reader who follows it keeps its last row in view, so
 * the button never flickers there.
 */
@Composable
fun rememberScrolledAway(list: LazyListState): Boolean {
    val away by remember(list) {
        derivedStateOf {
            val info = list.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: return@derivedStateOf false
            list.canScrollForward && last < info.totalItemsCount - 1
        }
    }
    return away
}

/**
 * "Jump to latest" (owner, 2026-10-27): a small round ↓ floating above the composer while the
 * reader has scrolled up, in a hub chat and in a Telegram or WhatsApp conversation alike — the
 * web's `JumpToLatest.tsx` and the iOS `JumpToLatestButton`. A long press names it.
 */
@Composable
fun JumpToLatest(onJump: () -> Unit, modifier: Modifier = Modifier) {
    HubIconButton(
        Lucide.ArrowDown,
        stringResource(R.string.chat_jump_latest),
        onJump,
        modifier.padding(bottom = 8.dp).testTag("chat.jump_latest"),
        kind = IconKind.Glass,
        size = 40.dp,
        iconSize = 18.dp,
    )
}
