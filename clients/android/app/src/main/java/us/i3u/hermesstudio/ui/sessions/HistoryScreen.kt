package us.i3u.hermesstudio.ui.sessions

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import us.i3u.hermesstudio.AppViewModel
import us.i3u.hermesstudio.ConfirmDialog
import us.i3u.hermesstudio.ErrorNote
import us.i3u.hermesstudio.NoticeNote
import us.i3u.hermesstudio.R
import us.i3u.hermesstudio.StudioHorizontalPadding
import us.i3u.hermesstudio.Tab
import us.i3u.hermesstudio.UiState
import us.i3u.hermesstudio.ui.navigation.MenuButton
import us.i3u.hermesstudio.ui.theme.CoreHub
import us.i3u.hermesstudio.ui.theme.CoreHubTextStyles

/**
 * The History section (the web's hermes.history route): the full session
 * browser with search, the "All profiles" and "Archived" filters, the same
 * grouped list as the drawer, batch selection (archive, restore, move,
 * delete) and "delete shown".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HistoryScreen(state: UiState, viewModel: AppViewModel, onMenu: () -> Unit) {
    val palette = CoreHub.palette
    var deleteVisible by remember { mutableStateOf(false) }
    var deleteSelected by remember { mutableStateOf(false) }
    var moveSelected by remember { mutableStateOf(false) }
    val shown = when {
        state.showArchived -> state.archivedSessions
        else -> state.sessionSearchResults ?: state.sessions
    }
    if (deleteVisible) {
        ConfirmDialog(
            title = stringResource(R.string.session_batch_delete),
            body = stringResource(R.string.session_batch_delete_body, shown.size),
            action = stringResource(R.string.action_delete),
            onConfirm = { viewModel.batchDeleteVisibleSessions(); deleteVisible = false },
            onDismiss = { deleteVisible = false },
        )
    }
    if (deleteSelected) {
        ConfirmDialog(
            title = stringResource(R.string.session_batch_delete),
            body = stringResource(R.string.session_batch_delete_body, state.sessionSelection.size),
            action = stringResource(R.string.action_delete),
            onConfirm = { viewModel.batchDeleteSelected(); deleteSelected = false },
            onDismiss = { deleteSelected = false },
        )
    }
    if (moveSelected) {
        BatchCategoryDialog(
            state = state,
            onPick = { id -> viewModel.batchMoveSelected(id); moveSelected = false },
            onDismiss = { moveSelected = false },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        if (state.sessionSelectionMode) stringResource(R.string.session_selection_count, state.sessionSelection.size)
                        else stringResource(R.string.segment_history),
                        style = MaterialTheme.typography.titleLarge,
                    )
                },
                navigationIcon = { MenuButton(onMenu) },
                actions = {
                    IconButton(onClick = { viewModel.setSessionSelectionMode(!state.sessionSelectionMode) }) {
                        Icon(
                            Icons.Filled.Checklist,
                            contentDescription = stringResource(R.string.session_select),
                            tint = if (state.sessionSelectionMode) palette.accent else palette.textSecondary,
                        )
                    }
                    IconButton(onClick = { deleteVisible = true }, enabled = shown.isNotEmpty() && !state.sessionSelectionMode) {
                        Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.session_batch_delete), tint = palette.textSecondary)
                    }
                    IconButton(
                        onClick = { if (state.showArchived) viewModel.loadArchivedSessions() else viewModel.refreshSessions() },
                        enabled = !state.refreshingSessions && !state.loadingArchived,
                    ) {
                        Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh), tint = palette.textSecondary)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.bgPrimary, scrolledContainerColor = palette.bgPrimary),
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            // A batch operation says what it did (or why it did not) right here.
            state.error?.let { ErrorNote(it) { viewModel.dismissError() } }
            state.notice?.let { NoticeNote(it) { viewModel.dismissNotice() } }
            FilterRow(state, viewModel)
            if (state.sessionSelectionMode) {
                SelectionBar(
                    state = state,
                    onSelectAll = { viewModel.selectAllVisibleSessions(shown) },
                    onArchive = { viewModel.batchArchiveSelected(!state.showArchived) },
                    onMove = { moveSelected = true },
                    onDelete = { deleteSelected = true },
                )
            }
            SessionListPane(
                state = state,
                viewModel = viewModel,
                modifier = Modifier.fillMaxSize(),
                showSearch = true,
                selectable = true,
                contentPadding = PaddingValues(start = StudioHorizontalPadding, end = StudioHorizontalPadding, top = 8.dp, bottom = 28.dp),
                onOpen = { session -> viewModel.showTab(Tab.Chat); viewModel.openSession(session) },
            )
        }
    }
}

/** "All profiles" and "Archived": the two filters the web's history page carries. */
@Composable
private fun FilterRow(state: UiState, viewModel: AppViewModel) {
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = StudioHorizontalPadding, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FilterChip(
            selected = state.allProfiles,
            onClick = { viewModel.setAllProfiles(!state.allProfiles); viewModel.refreshSessions() },
            label = { Text(stringResource(R.string.sessions_all_profiles)) },
        )
        FilterChip(
            selected = state.showArchived,
            onClick = { viewModel.setShowArchived(!state.showArchived) },
            label = { Text(stringResource(R.string.sessions_archived)) },
        )
    }
}

/** What the batch selection can do to the checked rows. */
@Composable
private fun SelectionBar(
    state: UiState,
    onSelectAll: () -> Unit,
    onArchive: () -> Unit,
    onMove: () -> Unit,
    onDelete: () -> Unit,
) {
    val palette = CoreHub.palette
    val any = state.sessionSelection.isNotEmpty()
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = StudioHorizontalPadding),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onSelectAll) { Text(stringResource(R.string.session_select_all), style = CoreHubTextStyles.meta, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        TextButton(onClick = onArchive, enabled = any) {
            Text(stringResource(if (state.showArchived) R.string.session_batch_unarchive else R.string.session_batch_archive), style = CoreHubTextStyles.meta, maxLines = 1)
        }
        TextButton(onClick = onMove, enabled = any) { Text(stringResource(R.string.session_batch_move), style = CoreHubTextStyles.meta, maxLines = 1) }
        TextButton(onClick = onDelete, enabled = any) { Text(stringResource(R.string.action_delete), color = palette.error, style = CoreHubTextStyles.meta, maxLines = 1) }
    }
}

/** Where the checked conversations go; "Uncategorized" clears the category. */
@Composable
private fun BatchCategoryDialog(state: UiState, onPick: (Int?) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.session_batch_move)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                TextButton(onClick = { onPick(null) }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.sessions_uncategorized), modifier = Modifier.fillMaxWidth())
                }
                state.sessionCategories.forEach { category ->
                    TextButton(onClick = { onPick(category.id) }, modifier = Modifier.fillMaxWidth()) {
                        Text(category.name, modifier = Modifier.fillMaxWidth(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}
