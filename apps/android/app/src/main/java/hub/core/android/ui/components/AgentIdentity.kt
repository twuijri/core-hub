package hub.core.android.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import hub.core.android.AppGraph
import hub.core.android.data.hubCall
import hub.core.android.graph
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.model.Agent
import hub.core.client.model.Avatar
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext

/**
 * Who an agent is on screen: its name as the hub's registry has it (a reply's author is only an
 * id and the placeholder «agent»), its catalog slug for its mark, and whether it has a picture
 * of its own (`agents.getAvatar`, DECISIONS §76).
 */
data class AgentIdentity(val id: String?, val name: String, val slug: String?, val hasPicture: Boolean) {
    companion object {
        /** What the hub writes as an agent message's author name when it names nobody. */
        const val PLACEHOLDER = "agent"

        /**
         * The identity of an author. [shownName] is the name the message carries: a room seat's
         * own name wins over the agent's; a chat reply's placeholder never does.
         */
        fun of(authorId: String?, shownName: String?, agents: List<Agent>, fallback: String): AgentIdentity {
            val agent = agents.firstOrNull { it.id == authorId }
            val name = shownName?.trim()?.takeIf { it.isNotEmpty() && it != PLACEHOLDER } ?: agent?.name?.takeIf { it.isNotBlank() } ?: fallback
            return AgentIdentity(authorId, name, agent?.slug, agent?.avatar?.kind == Avatar.Kind.IMAGE)
        }

        fun of(agent: Agent) = AgentIdentity(agent.id, agent.name, agent.slug, agent.avatar.kind == Avatar.Kind.IMAGE)
    }
}

/**
 * The agents of each profile, read once and kept while the app runs (an agent's name, mark and
 * picture barely change); a screen asks for its profile's with [ensure].
 */
class AgentDirectory(private val graph: AppGraph) {
    private val _byProfile = MutableStateFlow<Map<String, List<Agent>>>(emptyMap())
    val byProfile: StateFlow<Map<String, List<Agent>>> = _byProfile.asStateFlow()
    private val loading = ConcurrentHashMap.newKeySet<String>()

    suspend fun ensure(profile: String) {
        if (profile in _byProfile.value || !loading.add(profile)) return
        val session = graph.store.current
        if (session == null) {
            loading.remove(profile)
            return
        }
        hubCall { graph.apis(session).agents.agentsList(profile).items }
            .onSuccess { agents -> _byProfile.update { it + (profile to agents) } }
        loading.remove(profile)
    }

    /** A picture the hub keeps for an agent, fetched once into the cache. */
    suspend fun picture(context: android.content.Context, profile: String, agentId: String): File? = withContext(Dispatchers.IO) {
        val target = File(File(context.cacheDir, "avatars"), agentId)
        if (target.isFile && target.length() > 0) return@withContext target
        val session = graph.store.current ?: return@withContext null
        val fetched = hubCall { graph.apis(session).agents.agentsGetAvatar(profile, agentId) }.getOrNull() ?: return@withContext null
        runCatching {
            target.parentFile?.mkdirs()
            fetched.copyTo(target, overwrite = true)
            fetched.delete()
            target
        }.getOrNull()
    }

    fun forget() = _byProfile.update { emptyMap() }
}

/** The agents of [profile], loading them the first time a screen asks. */
@Composable
fun rememberAgents(profile: String): List<Agent> {
    val graph = LocalContext.current.graph
    val all by graph.agents.byProfile.collectAsState()
    LaunchedEffect(profile) { graph.agents.ensure(profile) }
    return all[profile].orEmpty()
}

/**
 * An agent's face: its own picture when it has one, else the mark of the agent we ship
 * (Hermes, Claude Code, Codex …, the web's `agentMark`), else its initial.
 */
@Composable
fun AgentAvatar(identity: AgentIdentity, profile: String, size: Dp = 24.dp, modifier: Modifier = Modifier) {
    val t = LocalTokens.current
    val context = LocalContext.current
    var picture by remember(identity.id) { mutableStateOf<ImageBitmap?>(null) }
    if (identity.hasPicture && identity.id != null) {
        LaunchedEffect(identity.id, profile) {
            val file = context.graph.agents.picture(context, profile, identity.id)
            picture = file?.let { withContext(Dispatchers.IO) { AttachmentFiles.decode(it, 256) } }
        }
    }
    Box(
        modifier.size(size).clip(CircleShape).background(t.accentSoft).testTag("agent.avatar"),
        contentAlignment = Alignment.Center,
    ) {
        val bitmap = picture
        val mark = AgentMarks.of(identity.slug)
        when {
            bitmap != null -> Image(bitmap, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(size))
            mark != null -> Icon(painterResource(mark), contentDescription = null, tint = t.accentSoftText, modifier = Modifier.size(size * 0.62f))
            else -> Text(
                identity.name.trim().take(1).uppercase().ifEmpty { "?" },
                style = MaterialTheme.typography.labelSmall,
                color = t.accentSoftText,
            )
        }
    }
}
