package us.i3u.hermesstudio

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GlobalAgentScreen(state: UiState, viewModel: AppViewModel) {
    val sessions = state.sessions.filter { it.source == "global_agent" }
    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.global_agent_title)) }, navigationIcon = { IconButton(viewModel::back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back)) } }, actions = { IconButton(viewModel::refreshSessions) { Icon(Icons.Filled.Refresh, stringResource(R.string.action_refresh)) } }) }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Text(stringResource(R.string.global_agent_description), style = MaterialTheme.typography.bodyLarge) }
            item { Text(stringResource(R.string.global_agent_profile, state.activeProfile.ifBlank { "default" }), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            item { Button(onClick = viewModel::startGlobalAgentConversation, Modifier.fillMaxWidth()) { Text(stringResource(R.string.global_agent_open)) } }
            item { Text(stringResource(R.string.global_agent_remote_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (sessions.isNotEmpty()) item { Text(stringResource(R.string.global_agent_sessions), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold) }
            items(sessions, key = { it.id }) { session ->
                Card(Modifier.fillMaxWidth().clickable { viewModel.openSession(session) }, shape = RoundedCornerShape(18.dp)) {
                    Column(Modifier.padding(15.dp)) { Text(session.title, fontWeight = FontWeight.Bold); Text(session.updatedAt.orEmpty(), style = MaterialTheme.typography.labelSmall) }
                }
            }
        }
    }
}
