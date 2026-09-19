package us.i3u.hermesstudio

import android.app.Application
import android.app.DownloadManager
import android.net.Uri
import android.os.Build
import android.media.MediaPlayer
import android.os.Environment
import android.webkit.MimeTypeMap
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class Screen {
    Loading, Onboarding, Login, Chats, Groups, AgentHub, Conversation, Room, Profiles,
    Settings, SettingsPage, SettingsGroup, History, Channels, Channel, CronJobs, CronJob, CronHistory,
    Kanban, KanbanTask, Skills, Skill, Plugins, Mcp, Pets, Insights, AgentRuntimes, Workflows, Workflow, WorkflowRun, GlobalAgent, EkkoHub, Files, Logs, Connections, Journey, Webhooks, RuntimeVersions, Appearance,
}

/** Settings is a short list of these; each opens its own screen. */
enum class SettingsGroup {
    Account, Server, Users, Webhooks, Profile, Models, Agent, Memory, Compression, Sessions,
    Privacy, Proxy, Display, Device, About,
}

/** The four-segment conversation switch in the drawer, like the web's PageSidebarNav. */
enum class Tab { Chat, Group, Workflow, History }

/** The screen a segment lands on; Chat keeps the open conversation when there is one. */
private fun Tab.rootScreen(openSession: SessionSummary? = null) = when (this) {
    Tab.Chat -> if (openSession != null) Screen.Conversation else Screen.Chats
    Tab.Group -> Screen.Groups
    Tab.Workflow -> Screen.Workflows
    Tab.History -> Screen.History
}

private fun Screen.isRootDestination() = this in setOf(Screen.Chats, Screen.Groups, Screen.Workflows, Screen.History, Screen.Login, Screen.Onboarding)
private fun Screen.isTransientDestination() = this == Screen.Loading

private data class SessionBootstrap(
    val user: CurrentUser,
    val profiles: List<Profile>,
    val sessions: List<SessionSummary>,
    /** A non-fatal problem met while restoring, shown as a notice once signed in. */
    val warning: String? = null,
    /** `webui_version` from /health, when the server reports one. */
    val version: String? = null,
)

private data class AccountSettingsData(
    val user: CurrentUser,
    val locks: List<LockedIp>,
    val avatar: AvatarSpec,
)

/** The message row variants of DESIGN-SPEC ("Message row"). */
enum class ChatLineKind { User, Assistant, System, Command, Error }

data class ChatLine(
    val text: String,
    val fromUser: Boolean,
    val isError: Boolean = false,
    val timestamp: String? = null,
    val sender: String? = null,
    /** What the model thought on the way to this answer, when it reports it. */
    val reasoning: String? = null,
    /** True while the words are still arriving. */
    val streaming: Boolean = false,
    /** Tool calls reported by Studio while this reply is being produced. */
    val tools: List<ChatToolStep> = emptyList(),
    /** Local timing keeps the live Thinking counter moving between events. */
    val startedAtMillis: Long? = null,
    val finishedAtMillis: Long? = null,
    /** When the first answer text arrived: the end of the observed thinking span. */
    val thinkingFinishedAtMillis: Long? = null,
    val messageId: String? = null,
    /** System notices (compression, aborts) and slash-command acknowledgements. */
    val system: Boolean = false,
    val command: Boolean = false,
) {
    val kind: ChatLineKind
        get() = when {
            isError -> ChatLineKind.Error
            command -> ChatLineKind.Command
            system -> ChatLineKind.System
            fromUser -> ChatLineKind.User
            else -> ChatLineKind.Assistant
        }

    /** Stable identity for per-message UI state (speech, expanded sections). */
    val key: String get() = messageId ?: "${startedAtMillis ?: 0}:${timestamp.orEmpty()}:${text.hashCode()}"
}

data class ChatToolStep(
    val id: String,
    val name: String,
    val detail: String?,
    val status: ToolRunStatus,
    val startedAtMillis: Long,
    val durationSeconds: Double? = null,
    val arguments: String? = null,
    val output: String? = null,
    val outputTruncated: Boolean = false,
    val outputOriginalLength: Long? = null,
    val reasoning: String? = null,
) {
    val hasDetails: Boolean get() = !arguments.isNullOrBlank() || !output.isNullOrBlank() || !reasoning.isNullOrBlank()
}

/** The banner shown while the server compresses the context, and its outcome. */
data class CompressionStatus(
    val running: Boolean,
    val messageCount: Int?,
    val beforeTokens: Long?,
    val afterTokens: Long?,
    val error: String?,
)

data class PendingRunAction(
    val kind: RequiredAction,
    val id: String,
    val prompt: String,
    val options: List<String>,
    val sessionId: String,
)

data class UiState(
    val screen: Screen = Screen.Login,
    val tab: Tab = Tab.Chat,
    val baseUrl: String = "",
    val busy: Boolean = false,
    val error: String? = null,
    val account: String? = null,
    val currentUser: CurrentUser? = null,
    val profiles: List<Profile> = emptyList(),
    /** Blank means "All profiles", the same default Studio shows. */
    val profileFilter: String = "",
    val activeProfile: String = "",
    val sessions: List<SessionSummary> = emptyList(),
    /** Drives both the toolbar refresh and the pull-to-refresh indicator. */
    val refreshingSessions: Boolean = false,
    /** Drawer "All profiles": list every profile's sessions instead of the active one's. */
    val allProfiles: Boolean = false,
    /** History › Archived: the archived conversations of the current filter. */
    val archivedSessions: List<SessionSummary> = emptyList(),
    val showArchived: Boolean = false,
    val loadingArchived: Boolean = false,
    /** Batch selection on the History page. */
    val sessionSelection: Set<String> = emptySet(),
    val sessionSelectionMode: Boolean = false,
    /** Paginated transcript: index of the oldest loaded message and whether older ones exist. */
    val historyOffset: Int = 0,
    val historyTotal: Int = 0,
    val historyHasMore: Boolean = false,
    val loadingOlderHistory: Boolean = false,
    val rooms: List<RoomInfo> = emptyList(),
    val loadingRooms: Boolean = false,
    val openSession: SessionSummary? = null,
    val openRoom: RoomState? = null,
    /** Files attached to the next room message, and the ones still uploading. */
    val roomAttachments: List<Upload> = emptyList(),
    val roomUploads: List<UploadProgress> = emptyList(),
    val loadingOlderRoom: Boolean = false,
    val agentPresets: List<AgentPreset> = emptyList(),
    val loadingPresets: Boolean = false,
    /** Live `/workflow` statuses by workflow id. */
    val workflowStatuses: Map<String, WorkflowLiveStatus> = emptyMap(),
    val openWorkflow: StudioWorkflow? = null,
    val openWorkflowRun: WorkflowRunDetail? = null,
    val loadingWorkflowRun: Boolean = false,
    val modelCatalog: ModelCatalog? = null,
    /** Device-side text scale (Settings › Display), 0.85–1.3. */
    val textScale: Float = 1f,
    val lines: List<ChatLine> = emptyList(),
    val loadingHistory: Boolean = false,
    val sending: Boolean = false,
    val attachments: List<Upload> = emptyList(),
    val attaching: Boolean = false,
    val voice: VoiceStatus = VoiceStatus.Idle,
    /** True while the running take is a server recording rather than on-device dictation. */
    val voiceViaServer: Boolean = false,
    /** The latest dictation text for the composer to place at the caret; consumed by serial. */
    val voiceSegment: VoiceSegment? = null,
    /** Store.VOICE_INPUT_DEVICE or Store.VOICE_INPUT_SERVER, from Settings → Voice. */
    val voiceInput: String = Store.VOICE_INPUT_DEVICE,
    /** The next submitted draft came from STT and should receive a spoken reply. */
    val voiceReplyPending: Boolean = false,
    val speaking: Boolean = false,
    val models: List<ModelOption> = emptyList(),
    /** Profile whose entries are currently in [models]. */
    val modelsProfile: String? = null,
    val loadingModels: Boolean = false,
    /** Blank means the profile default, matching Studio's "Default" chip. */
    val reasoningEffort: String = "",
    /** BCP-47 tag chosen in Settings; blank follows the system. */
    val language: String = "",
    /** system, light, or dark. */
    val appearance: String = "system",
    val sessionModel: String? = null,
    val sessionProvider: String? = null,
    val contextTokens: Long = 0,
    val contextWindow: Long = 0,
    val loadingContext: Boolean = false,
    val defaultModel: String? = null,
    val savingSetting: Boolean = false,
    /** The tool the agent is running right now, when it says so. */
    val activity: String? = null,
    /** True once the room socket is carrying messages. */
    val roomLive: Boolean = false,
    val serverConfig: ServerConfig? = null,
    /** The channel whose settings are open, if any. */
    val openChannel: String? = null,
    val weixinQr: WeixinQrUi = WeixinQrUi(),
    val openGroup: SettingsGroup? = null,
    /** Parent hub for a settings group, channel list, or scheduled-jobs list. */
    val toolReturnScreen: Screen = Screen.Settings,
    /** Exact screen that opened Profiles; it is shared by several root surfaces. */
    val profilesReturnScreen: Screen = Screen.Chats,
    val agentSettings: AgentSettings? = null,
    val autoStart: AutoStartPolicy? = null,
    val loadingAgentSettings: Boolean = false,
    val studioSettings: StudioSettings? = null,
    val loadingStudioSettings: Boolean = false,
    val lockedIps: List<LockedIp> = emptyList(),
    val accountAvatar: AvatarSpec? = null,
    val loadingAccountSettings: Boolean = false,
    val managedUsers: List<ManagedUser> = emptyList(),
    val managedProfiles: List<String> = emptyList(),
    val loadingManagedUsers: Boolean = false,
    val modelProviders: List<ModelProvider> = emptyList(),
    val loadingModelProviders: Boolean = false,
    val cronJobs: List<CronJob> = emptyList(),
    val cronLoading: Boolean = false,
    /** The job currently running a pause/resume/run/delete request. */
    val cronActionId: String? = null,
    val editingCronJob: CronJob? = null,
    val cronEditorJobId: String? = null,
    val cronEditorLoading: Boolean = false,
    val cronSkills: List<String> = emptyList(),
    val cronDeliveryTargets: List<CronDeliveryTarget> = emptyList(),
    val cronHistoryJob: CronJob? = null,
    val cronRuns: List<CronRun> = emptyList(),
    val cronHistoryLoading: Boolean = false,
    val cronRunLoading: Boolean = false,
    val openCronRun: CronRunDetail? = null,
    val kanban: KanbanUiState = KanbanUiState(),
    val skillsUi: SkillsUiState = SkillsUiState(),
    val pluginsUi: PluginsUiState = PluginsUiState(),
    val mcpUi: McpUiState = McpUiState(),
    val petsUi: PetsUiState = PetsUiState(),
    val usageStats: UsageStats? = null,
    val usageDays: Int = 30,
    val runtimePerformance: RuntimePerformance? = null,
    val loadingInsights: Boolean = false,
    val notice: String? = null,
    val agentRuntimes: List<AgentRuntimeStatus> = emptyList(),
    val loadingAgentRuntimes: Boolean = false,
    val selectedRuntime: AgentRuntimeSelection = AgentRuntimeSelection(),
    val pendingRunAction: PendingRunAction? = null,
    /** Composer ⚙ menu. */
    val showToolCalls: Boolean = true,
    val speakReplies: Boolean = false,
    val sessionPushEnabled: Boolean = false,
    /** Attachments still going up through `/api/studio/app-uploads`. */
    val uploads: List<UploadProgress> = emptyList(),
    val compression: CompressionStatus? = null,
    /** "started" / "timeout" while an abort is in flight; null otherwise. */
    val abortPhase: String? = null,
    /** An agent asked for the phone's position; the consent dialog is open. */
    val locationRequest: LocationRequest? = null,
    /** [ChatLine.key] of the message being read aloud, and whether it is paused. */
    val speakingKey: String? = null,
    val speechPaused: Boolean = false,
    val speechLoadingKey: String? = null,
    val queuedRuns: List<QueuedRun> = emptyList(),
    val queueInsertionActive: Boolean = false,
    val backgroundAgentRuns: List<BackgroundAgentRun> = emptyList(),
    val workspaceRunChanges: List<WorkspaceRunChange> = emptyList(),
    val sessionCategories: List<SessionCategory> = emptyList(),
    val sessionSearchResults: List<SessionSummary>? = null,
    val sessionLimit: Int = 80,
    /** Device-side session pins for the active profile (the web keeps them in localStorage). */
    val pinnedSessionIds: Set<String> = emptySet(),
    /** Size of the RECENT group, 1–100. */
    val recentCount: Int = 10,
    /** Sessions whose run completed while another screen was open. */
    val unreadSessionIds: Set<String> = emptySet(),
    /** `webui_version` from /health, printed as "Core Hub v…" in the drawer footer. */
    val serverVersion: String? = null,
    /** False after a request failed to reach the server; true after any success. */
    val connected: Boolean = true,
    val workflows: List<StudioWorkflow> = emptyList(),
    val workflowRuns: Map<String, List<StudioWorkflowRun>> = emptyMap(),
    val workflowSchedules: Map<String, List<WorkflowSchedule>> = emptyMap(),
    val loadingWorkflows: Boolean = false,
    val ekkoMemories: List<EkkoMemory> = emptyList(),
    val ekkoSkills: List<SkillCategory> = emptyList(),
    val ekkoMcpServers: List<EkkoMcpServer> = emptyList(),
    val loadingEkko: Boolean = false,
    val profileRuntimeStatuses: Map<String, String> = emptyMap(),
    val filesPath: String = "",
    val studioFiles: List<StudioFile> = emptyList(),
    val openFile: StudioFile? = null,
    val openFileContent: String = "",
    val studioLogs: List<StudioLogFile> = emptyList(),
    val openLog: StudioLogFile? = null,
    val logEntries: List<StudioLogEntry> = emptyList(),
    val appRelay: AppRelayStatus? = null,
    val studioDevices: List<StudioDevice> = emptyList(),
    val appConnections: List<AppConnection> = emptyList(),
    val appAuthorization: AppAuthorization? = null,
    val ekkoExternalDirectories: List<String> = emptyList(),
    val ekkoOpenSkill: SkillInfo? = null,
    val ekkoSkillContent: String = "",
    val ekkoSkillFiles: List<String> = emptyList(),
    val ekkoSkillFilePreviewPath: String? = null,
    val ekkoSkillFilePreviewContent: String = "",
    val pairingLink: String = "",
    val peerConnections: List<PeerConnection> = emptyList(),
    val journey: JourneyGraph? = null,
    val skillUsage: SkillUsage? = null,
    val webhooks: List<WebhookEndpoint> = emptyList(),
    val webhookEvents: List<String> = emptyList(),
    val runtimeVersions: RuntimeVersions? = null,
    val themeSettings: ThemeSettings? = null,
    val kanbanDiagnostics: List<String> = emptyList(),
    val kanbanStats: String = "",
    val kanbanLog: String = "",
    val kanbanAttachments: List<String> = emptyList(),
)

data class WeixinQrUi(
    val status: String = "idle",
    val id: String = "",
    val url: String = "",
)

/** Super-admin gates the Agent Manager, Performance, Profiles and the admin settings tabs. */
val UiState.isSuperAdmin: Boolean get() = currentUser?.role == "super_admin"

class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val store = Store(app)

    /** Resolves strings in the language chosen in Settings, not the phone's. */
    private val localized = AppLocale.wrap(app)
    private val api = HermesApi(store.baseUrl, store.token)
    private val chat = ChatSocket(store.baseUrl, store.token)
    private val group = GroupSocket(store.baseUrl, store.token)
    private val recorder = Recorder()
    private val speech = SpeechInput(app)
    private var voiceSerial = 0L
    private var lastPartial: String? = null
    private var speechPlayer: MediaPlayer? = null
    private var runJob: kotlinx.coroutines.Job? = null
    private var historyJob: kotlinx.coroutines.Job? = null
    private var roomJob: kotlinx.coroutines.Job? = null
    private var roomLoadJob: kotlinx.coroutines.Job? = null
    private var weixinQrJob: Job? = null
    private var openingRoomId: String? = null
    private var activeRunSessionId: String? = null
    private val resumePageIds = mutableMapOf<String, String>()
    private val queuedDownloadNames = mutableSetOf<String>()
    /** Actual visit order. Several Studio tools can be opened from more than one parent. */
    private val navigationHistory = ArrayDeque<Screen>()
    private var observedScreen: Screen? = null
    private var consumingBackNavigation = false

    private val _state = MutableStateFlow(
        UiState(
            // A configured install must never flash the credentials form: it reads
            // as "sign in again" even though the token is still good.
            screen = when {
                store.isConfigured -> Screen.Loading
                store.onboarded -> Screen.Login
                else -> Screen.Onboarding
            },
            baseUrl = store.baseUrl,
            reasoningEffort = store.reasoningEffort,
            language = store.language,
            appearance = store.appearance,
            voiceInput = store.voiceInput,
            showToolCalls = store.showToolCalls,
            speakReplies = store.speakReplies,
            allProfiles = store.allProfiles,
            textScale = store.textScale,
        ),
    )
    val state: StateFlow<UiState> = _state.asStateFlow()
    private val workflowSocket = WorkflowSocket(store.baseUrl, store.token)
    private var workflowJob: Job? = null
    private val roomUploadJobs = mutableMapOf<String, Job>()

    init {
        viewModelScope.launch {
            state.collect { snapshot ->
                val previous = observedScreen
                val current = snapshot.screen
                if (previous == null) {
                    observedScreen = current
                } else if (previous != current) {
                    if (consumingBackNavigation) {
                        consumingBackNavigation = false
                    } else if (current.isRootDestination()) {
                        navigationHistory.clear()
                    } else if (!previous.isTransientDestination()) {
                        if (navigationHistory.lastOrNull() != previous) navigationHistory.addLast(previous)
                    }
                    observedScreen = current
                }
            }
        }
        // The cached mark is on disk, so the launch screen can show it at once.
        viewModelScope.launch { AppLogo.load(app) }
        api.onUnauthorized = ::refreshAppTokenForRetry
        if (store.isConfigured) restoreSession()
    }

    fun finishOnboarding() {
        store.onboarded = true
        _state.update { it.copy(screen = Screen.Login) }
    }

    private fun restoreSession() = launchWork(
        work = {
            api.update(store.baseUrl, store.token)
            chat.update(store.baseUrl, store.token)
            group.update(store.baseUrl, store.token)
            workflowSocket.update(store.baseUrl, store.token)
            val warning = refreshAppTokenIfDue()
            val user = api.currentUser()
            val profiles = api.profiles()
            api.activeProfile = pickProfile(profiles)
            SessionBootstrap(user, profiles, api.sessions(if (store.allProfiles) null else api.activeProfile), warning, runCatching { api.serverVersion() }.getOrNull())
        },
        onSuccess = { bootstrap ->
            val (user, profiles, sessions, warning) = bootstrap
            _state.update {
                it.copy(
                    screen = Screen.Chats,
                    account = user.username,
                    currentUser = user,
                    profiles = profiles,
                    activeProfile = pickProfile(profiles),
                    sessions = sessions,
                    error = null,
                    notice = warning,
                )
            }
            applySessionPrefs(bootstrap.version)
            syncBranding()
        },
        onFailure = { failure ->
            if (failure.invalidatesSavedSession()) {
                store.clearCredentials()
                _state.update {
                    it.copy(
                        screen = Screen.Login,
                        error = str(R.string.error_session_expired, failure.readableMessage(localized)),
                    )
                }
            } else {
                // A timeout or an offline server does not invalidate a token.
                // Keep the launch screen and let the user retry in place.
                _state.update {
                    it.copy(
                        screen = Screen.Loading,
                        error = str(R.string.error_session_restore, failure.readableMessage(localized)),
                    )
                }
            }
        },
    )

    fun retrySession() {
        if (!store.isConfigured || _state.value.busy) return
        _state.update { it.copy(screen = Screen.Loading, error = null) }
        restoreSession()
    }

    fun login(baseUrl: String, username: String, password: String) {
        val normalized = normalizeUrl(baseUrl)
        if (normalized == null) {
            _state.update { it.copy(error = str(R.string.error_server_address)) }
            return
        }
        if (username.isBlank() || password.isBlank()) {
            _state.update { it.copy(error = str(R.string.error_credentials_required)) }
            return
        }

        launchWork(
            work = {
                api.update(normalized, "")
                val token = api.login(username.trim(), password)
                store.baseUrl = normalized
                // A password token has no App expiry, so it is never refreshed.
                store.saveAppToken(token, expiresAt = 0L, connectionId = 0)
                api.update(normalized, token)
                chat.update(normalized, token)
                group.update(normalized, token)
                workflowSocket.update(normalized, token)
                val user = api.currentUser()
                SessionBootstrap(user, api.profiles(), api.sessions(null), version = runCatching { api.serverVersion() }.getOrNull())
            },
            onSuccess = { bootstrap -> enterSignedIn(normalized, bootstrap) },
        )
    }

    /**
     * Signs in with the JSON payload of the QR code Core Hub shows under
     * Device connections → App → Direct connection.
     */
    fun loginWithQr(raw: String) {
        val payload = AppConnectionPayload.parse(raw)
        if (payload == null) {
            _state.update { it.copy(error = str(R.string.error_qr_invalid)) }
            return
        }
        if (payload.isExpired()) {
            _state.update { it.copy(error = str(R.string.error_qr_expired)) }
            return
        }
        val app = getApplication<Application>()
        launchWork(
            work = {
                api.update(payload.backendUrl, "")
                val result = try {
                    api.appLogin(
                        authorizationCode = payload.authorizationCode,
                        deviceCode = store.deviceCode,
                        deviceName = deviceDisplayName(app),
                        deviceBrand = Build.BRAND.orEmpty(),
                        deviceModel = Build.MODEL.orEmpty(),
                    )
                } catch (failure: HermesException) {
                    throw HermesException(appLoginMessage(failure), failure.statusCode, failure.code)
                }
                store.baseUrl = payload.backendUrl
                store.saveAppToken(result.token, result.connection.tokenExpiresAt, result.connection.id)
                api.update(payload.backendUrl, result.token)
                chat.update(payload.backendUrl, result.token)
                group.update(payload.backendUrl, result.token)
                workflowSocket.update(payload.backendUrl, result.token)
                val user = api.currentUser()
                SessionBootstrap(user, api.profiles(), api.sessions(null), version = runCatching { api.serverVersion() }.getOrNull())
            },
            onSuccess = { bootstrap -> enterSignedIn(payload.backendUrl, bootstrap) },
        )
    }

    /** Camera permission was declined, so the QR path cannot start. */
    fun reportCameraDenied() = _state.update { it.copy(error = str(R.string.error_camera_permission)) }

    /** Microphone permission was declined, so no voice input can start. */
    fun reportMicrophoneDenied() = _state.update {
        it.copy(voice = VoiceStatus.Error, error = str(R.string.error_speech_permission))
    }

    private fun enterSignedIn(baseUrl: String, bootstrap: SessionBootstrap) {
        val (user, profiles, sessions, warning) = bootstrap
        _state.update {
            it.copy(
                screen = Screen.Chats,
                baseUrl = baseUrl,
                account = user.username,
                currentUser = user,
                profiles = profiles,
                activeProfile = pickProfile(profiles),
                sessions = sessions,
                error = null,
                notice = warning,
            )
        }
        applySessionPrefs(bootstrap.version)
        syncBranding()
    }

    /** The server's own words are in English; these are the messages the user sees. */
    private fun appLoginMessage(failure: HermesException): String = when (failure.statusCode) {
        400 -> str(R.string.error_app_login_fields)
        401 -> str(R.string.error_app_login_invalid_code)
        403 -> str(R.string.error_app_login_disabled)
        409 -> str(R.string.error_app_login_used)
        410 -> str(R.string.error_app_login_expired)
        else -> failure.readableMessage(localized)
    }

    private fun deviceDisplayName(app: Application): String {
        val named = runCatching {
            android.provider.Settings.Global.getString(app.contentResolver, android.provider.Settings.Global.DEVICE_NAME)
        }.getOrNull()
        return named?.trim()?.takeIf { it.isNotBlank() } ?: Build.MODEL.orEmpty().ifBlank { "Android" }
    }

    // ── App token refresh ─────────────────────────────────────────────────

    /**
     * Refreshes on launch when the token has under a week left or was last
     * refreshed more than a day ago. Returns a warning to show when the server
     * declined for a reason other than revocation; a 401 ends the session.
     */
    private fun refreshAppTokenIfDue(): String? {
        if (!store.hasAppToken) return null
        if (!AppTokenPolicy.shouldRefresh(store.tokenExpiresAt, store.tokenRefreshedAt)) return null
        return try {
            persistRefreshedToken(api.appRefresh())
            null
        } catch (failure: HermesException) {
            if (failure.statusCode == 401) throw HermesException(str(R.string.error_token_revoked), 401, failure.code)
            str(R.string.notice_token_refresh_failed, failure.readableMessage(localized))
        } catch (failure: java.io.IOException) {
            str(R.string.notice_token_refresh_failed, failure.readableMessage(localized))
        }
    }

    /**
     * Called by [HermesApi] on the request thread when a call returns 401.
     * Returns the new token to retry with, or null so the 401 is reported.
     */
    private fun refreshAppTokenForRetry(): String? {
        if (!store.hasAppToken) return null
        return try {
            persistRefreshedToken(api.appRefresh()).token
        } catch (failure: HermesException) {
            if (failure.statusCode == 401) signOutRevoked()
            null
        } catch (failure: java.io.IOException) {
            // The original 401 is reported to the caller; nothing is hidden.
            null
        }
    }

    private fun persistRefreshedToken(refreshed: AppTokenRefresh): AppTokenRefresh {
        store.saveAppToken(refreshed.token, refreshed.expiresAt, refreshed.connection.id.takeIf { it > 0 } ?: store.appConnectionId)
        api.update(store.baseUrl, refreshed.token)
        chat.update(store.baseUrl, refreshed.token)
        group.update(store.baseUrl, refreshed.token)
        workflowSocket.update(store.baseUrl, refreshed.token)
        return refreshed
    }

    /** The server no longer accepts this device's token: back to the login screen, saying why. */
    private fun signOutRevoked() {
        viewModelScope.launch {
            signOut()
            _state.update { it.copy(error = str(R.string.error_token_revoked)) }
        }
    }

    /** Device-side session preferences for the active profile, plus the server version. */
    private fun applySessionPrefs(version: String?) {
        _state.update {
            it.copy(
                pinnedSessionIds = store.pinnedSessions(it.activeProfile.ifBlank { "default" }),
                recentCount = store.recentCount,
                serverVersion = version ?: it.serverVersion,
                connected = true,
            )
        }
    }

    /** Pins are a device preference per profile, exactly like the web sidebar. */
    fun togglePinnedSession(session: SessionSummary) {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        val next = _state.value.pinnedSessionIds.toMutableSet().apply { if (!add(session.id)) remove(session.id) }
        store.setPinnedSessions(profile, next)
        _state.update { it.copy(pinnedSessionIds = next) }
    }

    /** RECENT group size (1–100), from the gear on the group header. */
    fun setRecentCount(count: Int) {
        store.recentCount = count
        _state.update { it.copy(recentCount = store.recentCount) }
    }

    /** Pulls the Studio logo from the connected server for the launch screen. */
    private fun syncBranding(force: Boolean = false) {
        viewModelScope.launch {
            runCatching { AppLogo.syncFromServer(getApplication<Application>(), api, force) }
        }
    }

    // ── lists ─────────────────────────────────────────────────────────────

    /** The drawer's conversation switch: Chat, Group Chat, Workflow, History. */
    fun showTab(tab: Tab) {
        if (_state.value.screen == Screen.Conversation && tab != Tab.Chat) cancelActiveRun(abort = false)
        if (tab != Tab.Workflow) stopListeningToWorkflows()
        navigationHistory.clear()
        _state.update { it.copy(tab = tab, error = null, sessionSelection = emptySet(), sessionSelectionMode = false) }
        when (tab) {
            Tab.Chat -> {
                _state.update { it.copy(screen = Tab.Chat.rootScreen(it.openSession)) }
                if (_state.value.sessions.isEmpty()) refreshSessions()
            }
            Tab.Group -> {
                _state.update { it.copy(screen = Screen.Groups) }
                if (_state.value.rooms.isEmpty()) refreshRooms()
            }
            Tab.Workflow -> openWorkflows()
            Tab.History -> {
                _state.update { it.copy(screen = Screen.History) }
                refreshSessions()
                loadSessionCategories()
            }
        }
    }

    /** Agent Manager (super-admin): every agent tool in one place. */
    fun openAgentManager() {
        _state.update { it.copy(screen = Screen.AgentHub, error = null, notice = null) }
        refreshServerConfig()
        if (_state.value.cronJobs.isEmpty()) refreshCronJobs()
    }

    fun refreshSessions() {
        if (_state.value.refreshingSessions) return
        val profile = sessionsProfile()
        _state.update { it.copy(refreshingSessions = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.sessions(profile, _state.value.sessionLimit) } }
                .onSuccess { sessions ->
                    _state.update {
                        it.copy(
                            sessions = sessions,
                            refreshingSessions = false,
                            connected = true,
                            sessionSelection = it.sessionSelection.filterTo(HashSet()) { id -> sessions.any { s -> s.id == id } || it.archivedSessions.any { s -> s.id == id } },
                        )
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(
                            refreshingSessions = false,
                            connected = failure !is java.io.IOException,
                            error = failure.readableMessage(localized),
                        )
                    }
                }
        }
    }
    fun loadMoreSessions() { _state.update { it.copy(sessionLimit = it.sessionLimit + 80) }; refreshSessions() }

    private var searchJob: Job? = null

    /** Titles and message text, debounced; results carry the matching snippet. */
    fun searchSessions(query: String) {
        searchJob?.cancel()
        if (query.isBlank()) { _state.update { it.copy(sessionSearchResults = null) }; return }
        val profile = sessionsProfile()
        searchJob = viewModelScope.launch {
            delay(250)
            runCatching { withContext(Dispatchers.IO) { api.searchSessions(query.trim(), profile) } }
                .onSuccess { results -> _state.update { it.copy(sessionSearchResults = results) } }
                .onFailure { failure ->
                    if (failure is kotlinx.coroutines.CancellationException) return@onFailure
                    _state.update { it.copy(sessionSearchResults = emptyList(), error = failure.readableMessage(localized)) }
                }
        }
    }

    // ── History: archive view and batch selection ─────────────────────────

    fun setShowArchived(show: Boolean) {
        _state.update { it.copy(showArchived = show, sessionSelection = emptySet(), sessionSelectionMode = false) }
        if (show) loadArchivedSessions()
    }

    fun loadArchivedSessions() {
        val profile = sessionsProfile()
        _state.update { it.copy(loadingArchived = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.archivedSessions(profile) } }
                .onSuccess { archived -> _state.update { it.copy(archivedSessions = archived, loadingArchived = false, connected = true) } }
                .onFailure { failure -> _state.update { it.copy(loadingArchived = false, connected = failure !is java.io.IOException, error = failure.readableMessage(localized)) } }
        }
    }

    fun setSessionSelectionMode(enabled: Boolean) = _state.update {
        it.copy(sessionSelectionMode = enabled, sessionSelection = if (enabled) it.sessionSelection else emptySet())
    }

    fun toggleSessionSelected(session: SessionSummary) = _state.update {
        val next = it.sessionSelection.toMutableSet().apply { if (!add(session.id)) remove(session.id) }
        it.copy(sessionSelection = next, sessionSelectionMode = true)
    }

    fun selectAllVisibleSessions(visible: List<SessionSummary>) = _state.update {
        val ids = visible.map { s -> s.id }.toSet()
        it.copy(sessionSelection = if (it.sessionSelection.containsAll(ids)) it.sessionSelection - ids else it.sessionSelection + ids, sessionSelectionMode = true)
    }

    private fun afterBatch(result: BatchResult, success: Int, partial: Int) {
        _state.update {
            it.copy(
                sessionSelection = emptySet(),
                sessionSelectionMode = false,
                sessionSearchResults = null,
                notice = if (result.failed == 0) str(success, result.updated) else str(partial, result.updated, result.failed),
                error = result.firstError?.takeIf { result.failed > 0 },
            )
        }
        refreshSessions()
        if (_state.value.showArchived) loadArchivedSessions()
    }

    /** POST /sessions/batch-archive for the selection (archive or restore). */
    fun batchArchiveSelected(archived: Boolean) {
        val ids = _state.value.sessionSelection.toList()
        if (ids.isEmpty()) return
        launchWork(
            work = { api.batchArchiveSessions(ids, archived) },
            onSuccess = { result ->
                afterBatch(
                    result,
                    if (archived) R.string.session_batch_archived else R.string.session_batch_unarchived,
                    if (archived) R.string.session_batch_archive_partial else R.string.session_batch_unarchive_partial,
                )
            },
        )
    }

    /** POST /sessions/batch-delete for the selection. */
    fun batchDeleteSelected() {
        val ids = _state.value.sessionSelection.toList()
        if (ids.isEmpty()) return
        launchWork(
            work = { api.batchDeleteSessions(ids); ids },
            onSuccess = { deleted ->
                deleted.forEach { id -> _state.value.profiles.forEach { p -> if (store.sessionFor(p.name) == id) store.setSessionFor(p.name, "") } }
                afterBatch(BatchResult(deleted.size, 0, null), R.string.session_batch_deleted, R.string.session_batch_deleted)
            },
        )
    }

    /** Moves every selected session into [categoryId] (null = uncategorized); one call per session, as the web does. */
    fun batchMoveSelected(categoryId: Int?) {
        val ids = _state.value.sessionSelection.toList()
        if (ids.isEmpty()) return
        launchWork(
            work = {
                var failed = 0
                var firstError: String? = null
                ids.forEach { id -> runCatching { api.setSessionCategory(id, categoryId) }.onFailure { failed++; if (firstError == null) firstError = it.message } }
                BatchResult(ids.size - failed, failed, firstError)
            },
            onSuccess = { result -> afterBatch(result, R.string.session_batch_moved, R.string.session_batch_move_partial) },
        )
    }

    /** Category ⋯ → "Move sessions": every member of [category] goes to [targetId]. */
    fun moveCategorySessions(category: SessionCategory, targetId: Int?) {
        val ids = _state.value.sessions.filter { it.categoryId == category.id }.map { it.id }
        if (ids.isEmpty()) return
        _state.update { it.copy(sessionSelection = ids.toSet()) }
        batchMoveSelected(targetId)
    }

    /** History › Archived → Unarchive one row. */
    fun unarchiveSession(session: SessionSummary) = launchWork(
        work = { api.archiveSession(session.id, false) },
        onSuccess = {
            _state.update { it.copy(archivedSessions = it.archivedSessions.filterNot { s -> s.id == session.id }, notice = str(R.string.session_unarchived)) }
            refreshSessions()
        },
    )

    fun loadSessionCategories() {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.sessionCategories() } }
                .onSuccess { categories -> _state.update { it.copy(sessionCategories = categories) } }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    fun createSessionCategory(name: String) = launchWork(
        work = { api.createSessionCategory(name) },
        onSuccess = { category -> _state.update { it.copy(sessionCategories = it.sessionCategories + category) } },
    )
    fun renameSessionCategory(category: SessionCategory, name: String) = launchWork(work = { api.renameSessionCategory(category.id, name) }, onSuccess = { loadSessionCategories() })
    fun deleteSessionCategory(category: SessionCategory) = launchWork(work = { api.deleteSessionCategory(category.id) }, onSuccess = { loadSessionCategories(); refreshSessions() })

    fun setSessionCategory(session: SessionSummary, categoryId: Int?) = launchWork(
        work = { api.setSessionCategory(session.id, categoryId) },
        onSuccess = { refreshSessions(); _state.update { it.copy(sessionSearchResults = null) } },
    )

    fun archiveSession(session: SessionSummary) = launchWork(
        work = { api.archiveSession(session.id, !session.archived) },
        onSuccess = { refreshSessions(); _state.update { it.copy(sessionSearchResults = null, notice = str(if (session.archived) R.string.session_unarchived else R.string.session_archived)) } },
    )
    fun setSessionWorkspace(session: SessionSummary, workspace: String) = launchWork(work = { api.setSessionWorkspace(session.id, workspace) }, onSuccess = { refreshSessions() })
    fun exportSession(session: SessionSummary) { val safe = session.title.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { session.id }; val request = DownloadManager.Request(Uri.parse(api.sessionExportUrl(session.id))).setTitle("$safe.json").setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED).setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "$safe.json"); store.token.takeIf(String::isNotBlank)?.let { request.addRequestHeader("Authorization", "Bearer $it") }; getApplication<Application>().getSystemService(DownloadManager::class.java)?.enqueue(request) }
    fun batchDeleteVisibleSessions() { val ids = (_state.value.sessionSearchResults ?: _state.value.sessions).map { it.id }; if (ids.isEmpty()) return; launchWork(work = { api.batchDeleteSessions(ids) }, onSuccess = { refreshSessions() }) }

    /** The Workflow section: the list, its runs and schedules, plus the live `/workflow` subscription. */
    fun openWorkflows() {
        _state.update { it.copy(screen = Screen.Workflows, loadingWorkflows = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.workflows(sessionsProfile()) } }
                .onSuccess { workflows ->
                    val problems = mutableListOf<Throwable>()
                    val runs = withContext(Dispatchers.IO) { workflows.associate { it.id to runCatching { api.workflowRuns(it.id) }.onFailure(problems::add).getOrDefault(emptyList()) } }
                    val schedules = withContext(Dispatchers.IO) { workflows.associate { it.id to runCatching { api.workflowSchedules(it.id) }.onFailure(problems::add).getOrDefault(emptyList()) } }
                    _state.update { state ->
                        state.copy(
                            workflows = workflows,
                            workflowRuns = runs,
                            workflowSchedules = schedules,
                            loadingWorkflows = false,
                            error = problems.firstOrNull()?.readableMessage(localized),
                            openWorkflow = state.openWorkflow?.let { open -> workflows.firstOrNull { it.id == open.id } ?: open },
                        )
                    }
                }.onFailure { failure -> _state.update { it.copy(loadingWorkflows = false, error = failure.readableMessage(localized)) } }
        }
        listenToWorkflows()
    }

    /** Keeps [UiState.workflowStatuses] live while a workflow screen is open. */
    private fun listenToWorkflows() {
        if (workflowJob?.isActive == true) return
        val profile = _state.value.activeProfile.ifBlank { "default" }
        workflowJob = viewModelScope.launch {
            workflowSocket.subscribe(profile).collect { event ->
                when (event) {
                    is WorkflowEvent.Statuses -> {
                        _state.update { state ->
                            val merged = state.workflowStatuses + event.statuses.associateBy { it.workflowId }
                            val openRun = state.openWorkflowRun
                            val liveRun = event.statuses.firstOrNull { it.runId != null && it.runId == openRun?.run?.id }?.run
                            state.copy(workflowStatuses = merged, openWorkflowRun = liveRun ?: openRun)
                        }
                        // A run that just finished changes the run list of its workflow.
                        val finished = event.statuses.filter { it.status == "completed" || it.status == "failed" || it.status == "canceled" }
                        if (finished.isNotEmpty()) refreshWorkflowRuns(finished.map { it.workflowId })
                    }
                    is WorkflowEvent.StatusError -> _state.update { it.copy(error = event.error) }
                    is WorkflowEvent.Failed -> _state.update { it.copy(error = event.error) }
                    WorkflowEvent.Connected, WorkflowEvent.Dropped -> Unit
                }
            }
        }
    }

    private fun stopListeningToWorkflows() {
        workflowJob?.cancel()
        workflowJob = null
    }

    private fun refreshWorkflowRuns(ids: List<String>) {
        viewModelScope.launch {
            val runs = withContext(Dispatchers.IO) { ids.associateWith { id -> runCatching { api.workflowRuns(id) }.getOrNull() } }
            _state.update { state -> state.copy(workflowRuns = state.workflowRuns + runs.filterValues { it != null }.mapValues { it.value!! }) }
        }
    }

    /** The workflow screen: read-only graph summary, runs and schedules. */
    fun openWorkflow(workflow: StudioWorkflow) {
        _state.update { it.copy(screen = Screen.Workflow, openWorkflow = workflow, error = null) }
        listenToWorkflows()
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { Triple(api.workflow(workflow.id), api.workflowRuns(workflow.id), api.workflowSchedules(workflow.id)) } }
                .onSuccess { (detail, runs, schedules) ->
                    _state.update { state ->
                        state.copy(
                            openWorkflow = if (state.openWorkflow?.id == workflow.id) detail else state.openWorkflow,
                            workflows = state.workflows.map { if (it.id == detail.id) detail else it },
                            workflowRuns = state.workflowRuns + (workflow.id to runs),
                            workflowSchedules = state.workflowSchedules + (workflow.id to schedules),
                        )
                    }
                }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    /** The run screen: node timeline with outputs and inline approvals. */
    fun openWorkflowRun(run: StudioWorkflowRun) {
        val workflow = _state.value.workflows.firstOrNull { it.id == run.workflowId } ?: _state.value.openWorkflow ?: return
        _state.update { it.copy(screen = Screen.WorkflowRun, openWorkflow = workflow, openWorkflowRun = null, loadingWorkflowRun = true, error = null) }
        listenToWorkflows()
        refreshWorkflowRun(run.workflowId, run.id)
    }

    fun refreshWorkflowRun(workflowId: String, runId: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.workflowRun(workflowId, runId) } }
                .onSuccess { detail -> _state.update { if (it.screen == Screen.WorkflowRun) it.copy(openWorkflowRun = detail, loadingWorkflowRun = false) else it } }
                .onFailure { failure -> _state.update { it.copy(loadingWorkflowRun = false, error = failure.readableMessage(localized)) } }
        }
    }

    /** Approve or reject the node waiting in [run]; [executionId] comes from the live status when known. */
    fun approveWorkflowNode(run: StudioWorkflowRun, nodeId: String, approved: Boolean, executionId: String? = null) = launchWork(
        work = { api.approveWorkflowNode(run.workflowId, run.id, nodeId, approved, executionId) },
        onSuccess = {
            _state.update { it.copy(notice = str(if (approved) R.string.workflow_node_approved else R.string.workflow_node_rejected)) }
            refreshWorkflowRun(run.workflowId, run.id)
            refreshWorkflowRuns(listOf(run.workflowId))
        },
    )

    fun rerunWorkflowFromNode(run: StudioWorkflowRun, nodeId: String) = launchWork(
        work = { api.rerunWorkflow(run.workflowId, run.id, nodeId) },
        onSuccess = { _state.update { it.copy(notice = str(R.string.workflow_rerun_started)) }; refreshWorkflowRuns(listOf(run.workflowId)) },
    )

    fun updateWorkflowSchedule(item: WorkflowSchedule, schedule: String, timezone: String, enabled: Boolean) = launchWork(
        work = { api.updateWorkflowSchedule(item, schedule, timezone, enabled) },
        onSuccess = { refreshWorkflowSchedules(item.workflowId) },
    )

    private fun refreshWorkflowSchedules(workflowId: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.workflowSchedules(workflowId) } }
                .onSuccess { schedules -> _state.update { it.copy(workflowSchedules = it.workflowSchedules + (workflowId to schedules)) } }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    fun runWorkflow(workflow: StudioWorkflow, input: String?) = launchWork(
        work = { api.runWorkflow(workflow.id, input) },
        onSuccess = { _state.update { it.copy(notice = str(R.string.workflow_run_started, workflow.name)) }; refreshWorkflowRuns(listOf(workflow.id)) },
    )

    fun stopWorkflowRun(run: StudioWorkflowRun) = launchWork(
        work = { api.stopWorkflowRun(run.workflowId, run.id) },
        onSuccess = { _state.update { it.copy(notice = str(R.string.workflow_run_stopped)) }; refreshWorkflowRuns(listOf(run.workflowId)); if (_state.value.openWorkflowRun?.run?.id == run.id) refreshWorkflowRun(run.workflowId, run.id) },
    )

    /** Backwards-compatible approval of whichever node the run reports as blocked. */
    fun approveWorkflowNode(run: StudioWorkflowRun, approved: Boolean) {
        val node = run.pendingNodeId ?: _state.value.workflowStatuses[run.workflowId]?.pendingApprovals?.firstOrNull()?.first ?: return
        approveWorkflowNode(run, node, approved, _state.value.workflowStatuses[run.workflowId]?.pendingApprovals?.firstOrNull { it.first == node }?.second)
    }
    fun deleteWorkflow(item: StudioWorkflow) = launchWork(work = { api.deleteWorkflow(item.id) }, onSuccess = { if (_state.value.openWorkflow?.id == item.id) _state.update { it.copy(openWorkflow = null, openWorkflowRun = null) }; openWorkflows() })
    fun deleteAllWorkflows() = launchWork(work = { api.batchDeleteWorkflows(_state.value.workflows.map { it.id }) }, onSuccess = { openWorkflows() })
    fun importWorkflow(document: String) = launchWork(work = { api.importWorkflow(document, sessionsProfile()) }, onSuccess = { name -> _state.update { it.copy(notice = str(R.string.workflow_imported, name)) }; openWorkflows() })
    fun exportWorkflow(item: StudioWorkflow) { val request = DownloadManager.Request(Uri.parse(api.workflowExportUrl(item.id))).setTitle("${item.name}.hermes-workflow.json").setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED).setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "${item.name.replace(Regex("[^A-Za-z0-9._-]"), "_")}.hermes-workflow.json"); store.token.takeIf(String::isNotBlank)?.let { request.addRequestHeader("Authorization", "Bearer $it") }; getApplication<Application>().getSystemService(DownloadManager::class.java)?.enqueue(request); _state.update { it.copy(notice = str(R.string.workflow_export_started)) } }
    fun deleteWorkflowRun(run: StudioWorkflowRun) = launchWork(work = { api.deleteWorkflowRun(run.workflowId, run.id) }, onSuccess = { if (_state.value.openWorkflowRun?.run?.id == run.id) back(); refreshWorkflowRuns(listOf(run.workflowId)) })
    fun rerunWorkflow(run: StudioWorkflowRun) { val node = run.pendingNodeId ?: return; rerunWorkflowFromNode(run, node) }
    fun createWorkflowSchedule(item: StudioWorkflow, expression: String, timezone: String) = launchWork(work = { api.createWorkflowSchedule(item.id, expression, timezone) }, onSuccess = { refreshWorkflowSchedules(item.id) })
    fun toggleWorkflowSchedule(item: WorkflowSchedule) = launchWork(work = { api.toggleWorkflowSchedule(item) }, onSuccess = { refreshWorkflowSchedules(item.workflowId) })
    fun deleteWorkflowSchedule(item: WorkflowSchedule) = launchWork(work = { api.deleteWorkflowSchedule(item) }, onSuccess = { refreshWorkflowSchedules(item.workflowId) })

    fun openGlobalAgent() = _state.update { it.copy(screen = Screen.GlobalAgent, error = null) }

    fun openEkkoHub() {
        _state.update { it.copy(screen = Screen.EkkoHub, loadingEkko = true, error = null) }
        val profile = currentProfile()
        viewModelScope.launch {
            val memory = runCatching { withContext(Dispatchers.IO) { api.ekkoMemories(profile) } }
            val skills = runCatching { withContext(Dispatchers.IO) { api.ekkoSkills(profile) } }
            val mcp = runCatching { withContext(Dispatchers.IO) { api.ekkoMcpServers(profile) } }
            val directories = runCatching { withContext(Dispatchers.IO) { api.ekkoExternalDirectories(profile) } }
            val error = memory.exceptionOrNull() ?: skills.exceptionOrNull() ?: mcp.exceptionOrNull() ?: directories.exceptionOrNull()
            _state.update { it.copy(ekkoMemories = memory.getOrDefault(emptyList()), ekkoSkills = skills.getOrDefault(emptyList()), ekkoMcpServers = mcp.getOrDefault(emptyList()), ekkoExternalDirectories = directories.getOrDefault(emptyList()), loadingEkko = false, error = error?.readableMessage(localized)) }
        }
    }

    fun saveEkkoMemory(memory: EkkoMemory, title: String, content: String) = launchWork(work = { api.updateEkkoMemory(currentProfile(), memory, title, content) }, onSuccess = { openEkkoHub() })
    fun deleteEkkoMemory(memory: EkkoMemory) = launchWork(work = { api.deleteEkkoMemory(currentProfile(), memory) }, onSuccess = { openEkkoHub() })
    fun toggleEkkoSkill(skill: SkillInfo) = launchWork(work = { api.setEkkoSkillEnabled(currentProfile(), skill.name, !skill.enabled) }, onSuccess = { openEkkoHub() })
    fun saveEkkoMcp(original: String?, name: String, config: String) = launchWork(work = { api.saveEkkoMcpServer(currentProfile(), original, name, config) }, onSuccess = { openEkkoHub() })
    fun toggleEkkoMcp(server: EkkoMcpServer) = launchWork(work = { api.toggleEkkoMcpServer(currentProfile(), server) }, onSuccess = { openEkkoHub() })
    fun testEkkoMcp(server: EkkoMcpServer) = launchWork(work = { api.testEkkoMcpServer(currentProfile(), server.name) }, onSuccess = { _state.update { it.copy(notice = str(R.string.ekko_mcp_test_ok)) } })
    fun deleteEkkoMcp(server: EkkoMcpServer) = launchWork(work = { api.deleteEkkoMcpServer(currentProfile(), server.name) }, onSuccess = { openEkkoHub() })

    fun restartProfile(profile: String) = launchWork(work = { api.restartProfileRuntime(profile) }, onSuccess = { refreshProfiles(); _state.update { it.copy(notice = str(R.string.profile_restarted)) } })
    fun refreshProviderModels(provider: String) = launchWork(work = { api.refreshProviderModels(currentProfile(), provider) }, onSuccess = { loadModelProviders(); _state.update { it.copy(notice = str(R.string.models_refreshed)) } })
    fun testProvider(provider: String) = launchWork(work = { api.testProvider(currentProfile(), provider) }, onSuccess = { result -> _state.update { it.copy(notice = result) } })

    fun openFiles(path: String = "") = launchWork(work = { api.studioFiles(currentProfile(), path) }, onSuccess = { files -> _state.update { it.copy(screen = Screen.Files, filesPath = path, studioFiles = files, openFile = null, error = null) } })
    fun openStudioFile(file: StudioFile) = launchWork(work = { api.readStudioFile(currentProfile(), file.path) }, onSuccess = { content -> _state.update { it.copy(openFile = file, openFileContent = content) } })
    fun closeStudioFile() = _state.update { it.copy(openFile = null, openFileContent = "") }
    fun saveStudioFile(content: String) { val file = _state.value.openFile ?: return; launchWork(work = { api.writeStudioFile(currentProfile(), file.path, content) }, onSuccess = { _state.update { it.copy(openFileContent = content, notice = str(R.string.files_saved)) } }) }
    fun createStudioFolder(name: String) { val path = listOf(_state.value.filesPath, name).filter(String::isNotBlank).joinToString("/"); launchWork(work = { api.mkdirStudioFile(currentProfile(), path) }, onSuccess = { openFiles(_state.value.filesPath) }) }
    fun renameStudioFile(file: StudioFile, name: String) { val target = file.path.substringBeforeLast('/', "").let { if (it.isBlank()) name else "$it/$name" }; launchWork(work = { api.renameStudioFile(currentProfile(), file.path, target) }, onSuccess = { openFiles(_state.value.filesPath) }) }
    fun copyStudioFile(file: StudioFile, destination: String) = launchWork(work = { api.copyStudioFile(currentProfile(), file.path, destination) }, onSuccess = { openFiles(_state.value.filesPath) })
    fun deleteStudioFile(file: StudioFile) = launchWork(work = { api.deleteStudioFile(currentProfile(), file) }, onSuccess = { openFiles(_state.value.filesPath) })
    fun studioFileUrl(file: StudioFile): String = api.studioFilePreviewUrl(currentProfile(), file.path)
    fun uploadStudioFile(bytes: ByteArray, name: String, mime: String) = launchWork(work = { api.uploadStudioFile(currentProfile(), _state.value.filesPath, bytes, name, mime) }, onSuccess = { openFiles(_state.value.filesPath) })

    fun openLogs() = launchWork(work = { api.studioLogs() }, onSuccess = { logs -> _state.update { it.copy(screen = Screen.Logs, studioLogs = logs, openLog = null, error = null) } })
    fun openLog(log: StudioLogFile) = launchWork(work = { api.studioLog(log.name, currentProfile()) }, onSuccess = { entries -> _state.update { it.copy(openLog = log, logEntries = entries) } })
    fun closeLog() = _state.update { it.copy(openLog = null, logEntries = emptyList()) }

    fun openConnections() = launchWork(
        work = { Triple(api.appRelayStatus(), api.studioDevices(), api.appConnections()) to (api.devicePairingLink() to api.peerConnections()) },
        onSuccess = { data ->
            val (primary, extra) = data
            val (relay, devices, connections) = primary
            _state.update { it.copy(screen = Screen.Connections, appRelay = relay, studioDevices = devices, appConnections = connections, pairingLink = extra.first, peerConnections = extra.second, error = null) }
        },
    )
    fun connectRelay() = launchWork(work = { api.connectAppRelay() }, onSuccess = { relay -> _state.update { it.copy(appRelay = relay) } })
    fun refreshRelayCode() = launchWork(work = { api.refreshAppRelayCode() }, onSuccess = { relay -> _state.update { it.copy(appRelay = relay) } })
    fun disconnectRelay() = launchWork(work = { api.disconnectAppRelay() }, onSuccess = { relay -> _state.update { it.copy(appRelay = relay) } })
    fun deviceAction(device: StudioDevice, action: String) = launchWork(work = { api.deviceAction(device.id, action) }, onSuccess = { openConnections() })
    fun createAppAuthorization(cloud: Boolean) = launchWork(work = { api.createAppAuthorization(cloud) }, onSuccess = { auth -> _state.update { it.copy(appAuthorization = auth) } })
    fun revokeAppConnection(connection: AppConnection) = launchWork(work = { api.revokeAppConnection(connection.id) }, onSuccess = { openConnections() })
    fun manualDeviceRequest(url: String) = launchWork(work = { api.manualDeviceRequest(url) }, onSuccess = { openConnections() })
    fun disconnectPeer(connection: PeerConnection) = launchWork(work = { api.disconnectPeer(connection.id) }, onSuccess = { openConnections() })

    fun switchActiveProfile(name: String) = launchWork(work = { api.switchActiveProfile(name) }, onSuccess = { selectProfile(name); refreshProfiles() })
    fun importProfile(bytes: ByteArray, name: String) = launchWork(work = { api.importProfile(bytes, name) }, onSuccess = { refreshProfiles() })
    fun profileExportUrl(name: String): String = api.profileExportUrl(name)
    fun updateProfileAvatar(name: String, dataUrl: String) = launchWork(work = { api.updateProfileAvatar(name, dataUrl) }, onSuccess = { refreshProfiles() })
    fun clearProfileAvatar(name: String) = launchWork(work = { api.clearProfileAvatar(name) }, onSuccess = { refreshProfiles() })

    fun saveEkkoSkill(name: String, content: String, creating: Boolean) = launchWork(work = { if (creating) api.createEkkoSkill(currentProfile(), name, content) else api.saveEkkoSkill(currentProfile(), name, content) }, onSuccess = { openEkkoHub() })
    fun deleteEkkoSkill(skill: SkillInfo) = launchWork(work = { api.deleteEkkoSkill(currentProfile(), skill.name) }, onSuccess = { openEkkoHub() })
    fun importEkkoSkill(bytes: ByteArray, name: String) = launchWork(work = { api.importEkkoSkill(currentProfile(), bytes, name) }, onSuccess = { openEkkoHub() })
    fun openEkkoSkill(skill: SkillInfo) = launchWork(work = { Triple(api.ekkoSkillDetail(currentProfile(), skill.name), api.ekkoSkillFiles(currentProfile(), skill.name), skill) }, onSuccess = { (content, files, selected) -> _state.update { it.copy(ekkoOpenSkill = selected, ekkoSkillContent = content, ekkoSkillFiles = files) } })
    fun closeEkkoSkill() = _state.update { it.copy(ekkoOpenSkill = null, ekkoSkillContent = "", ekkoSkillFiles = emptyList(), ekkoSkillFilePreviewPath = null, ekkoSkillFilePreviewContent = "") }
    fun openEkkoSkillFile(path: String) { val skill = _state.value.ekkoOpenSkill ?: return; launchWork(work = { api.ekkoSkillFile(currentProfile(), skill.name, path) }, onSuccess = { content -> _state.update { it.copy(ekkoSkillFilePreviewPath = path, ekkoSkillFilePreviewContent = content) } }) }
    fun saveExternalDirectories(lines: String) = launchWork(work = { api.saveEkkoExternalDirectories(currentProfile(), lines.lines().map(String::trim).filter(String::isNotBlank)) }, onSuccess = { openEkkoHub() })

    fun downloadProfile(name: String) {
        val request = DownloadManager.Request(Uri.parse(api.profileExportUrl(name))).setTitle("hermes-profile-$name.tar.gz").setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED).setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "hermes-profile-$name.tar.gz")
        store.token.takeIf(String::isNotBlank)?.let { request.addRequestHeader("Authorization", "Bearer $it") }
        getApplication<Application>().getSystemService(DownloadManager::class.java)?.enqueue(request)
        _state.update { it.copy(notice = str(R.string.profile_export_started)) }
    }

    fun openJourney() = launchWork(work = { api.journey() to api.skillUsage() }, onSuccess = { (journey, usage) -> _state.update { it.copy(screen = Screen.Journey, journey = journey, skillUsage = usage) } })
    fun openWebhooks() = launchWork(work = { api.webhooks() to api.webhookEvents() }, onSuccess = { (hooks, events) -> _state.update { it.copy(screen = Screen.Webhooks, webhooks = hooks, webhookEvents = events) } })
    fun createWebhook(name: String, url: String) = launchWork(work = { api.createWebhook(name, url) }, onSuccess = { openWebhooks() })
    fun toggleWebhook(item: WebhookEndpoint) = launchWork(work = { api.toggleWebhook(item) }, onSuccess = { openWebhooks() })
    fun updateWebhook(item: WebhookEndpoint, name: String, url: String) = launchWork(work = { api.updateWebhook(item.id, name, url) }, onSuccess = { openWebhooks() })
    fun deleteWebhook(item: WebhookEndpoint) = launchWork(work = { api.deleteWebhook(item.id) }, onSuccess = { openWebhooks() })
    fun testWebhook(item: WebhookEndpoint) = launchWork(work = { api.testWebhook(item.id) }, onSuccess = { result -> _state.update { it.copy(notice = result) } })
    fun clearWebhookEvents() = launchWork(work = { api.clearWebhookEvents() }, onSuccess = { openWebhooks() })
    fun openRuntimeVersions() = launchWork(work = { api.runtimeVersions() }, onSuccess = { versions -> _state.update { it.copy(screen = Screen.RuntimeVersions, runtimeVersions = versions) } })
    fun activateVersion(version: RuntimeVersion) = launchWork(work = { api.activateVersion(version.version, version.kind == "webui") }, onSuccess = { openRuntimeVersions() })
    fun downloadVersion(version: String, webUi: Boolean) = launchWork(work = { api.downloadVersion(version, webUi) }, onSuccess = { openRuntimeVersions() })
    fun restartWebUi() = launchWork(work = { api.restartWebUi() }, onSuccess = { openRuntimeVersions() })
    fun openAppearance() = launchWork(work = { api.themeSettings() }, onSuccess = { theme -> _state.update { it.copy(screen = Screen.Appearance, themeSettings = theme) } })
    fun saveTheme(fontSize: Int, text: String, accent: String) = launchWork(work = { api.updateTheme(fontSize, text, accent) }, onSuccess = { openAppearance() })
    fun removeThemeBackground() = launchWork(work = { api.removeThemeBackground() }, onSuccess = { openAppearance() })
    fun uploadThemeBackground(bytes: ByteArray, name: String, mime: String) = launchWork(work = { api.uploadThemeBackground(bytes, name, mime) }, onSuccess = { openAppearance() })
    fun loadKanbanOperations(taskId: String? = null) { val board = _state.value.kanban.board; if (board.isBlank()) return; launchWork(work = { val diagnostics = api.kanbanDiagnostics(board, taskId); val stats = api.kanbanStats(board); val extras = taskId?.let { api.kanbanLog(board, it) to api.kanbanAttachments(board, it) } ?: ("" to emptyList()); Triple(stats, diagnostics, extras) }, onSuccess = { (stats, diagnostics, extras) -> _state.update { it.copy(kanbanStats = stats, kanbanDiagnostics = diagnostics, kanbanLog = extras.first, kanbanAttachments = extras.second) } }) }
    fun kanbanCommand(task: KanbanTask, action: String, value: String = "") { val board = _state.value.kanban.board; launchWork(work = { api.kanbanCommand(board, task.id, action, value) }, onSuccess = { loadKanbanTask(task.id); loadKanbanOperations(task.id) }) }

    fun startGlobalAgentConversation() {
        startNewConversation(AgentRuntimeSelection("ekko-agent", "ekko", "Global Agent", globalAgent = true))
    }

    fun refreshRooms() {
        _state.update { it.copy(loadingRooms = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.rooms() } }
                .onSuccess { rooms -> _state.update { it.copy(rooms = rooms, loadingRooms = false, connected = true) } }
                .onFailure { failure -> _state.update { it.copy(loadingRooms = false, connected = failure !is java.io.IOException, error = failure.readableMessage(localized)) } }
        }
    }

    fun setProfileFilter(profile: String) {
        _state.update { it.copy(profileFilter = profile) }
        refreshSessions()
    }

    fun refreshProfiles() = launchWork(
        work = {
            val profiles = api.profiles()
            // Statuses decorate the list; a failure is shown but must not hide the profiles.
            val statuses = runCatching { api.profileRuntimeStatuses() }
            Triple(profiles, statuses.getOrDefault(emptyMap()), statuses.exceptionOrNull())
        },
        onSuccess = { (profiles, statuses, problem) ->
            _state.update {
                it.copy(
                    profiles = profiles,
                    activeProfile = pickProfile(profiles),
                    profileRuntimeStatuses = statuses,
                    error = problem?.readableMessage(localized),
                )
            }
        },
    )

    fun selectProfile(name: String) {
        cancelActiveRun(abort = false)
        historyJob?.cancel()
        historyJob = null
        store.profile = name
        api.activeProfile = name
        _state.update {
            it.copy(
                activeProfile = name,
                screen = Screen.Chats,
                tab = Tab.Chat,
                openSession = null,
                lines = emptyList(),
                attachments = emptyList(),
                sessionModel = null,
                sessionProvider = null,
                models = emptyList(),
                modelsProfile = null,
                defaultModel = null,
                serverConfig = null,
                agentSettings = null,
                autoStart = null,
                sessionSelection = emptySet(),
                sessionSelectionMode = false,
                archivedSessions = emptyList(),
                workflowStatuses = emptyMap(),
                modelCatalog = null,
            )
        }
        applySessionPrefs(null)
        refreshSessions()
    }

    /** Drawer toggle: every profile's sessions, or only the active profile's (the web's sidebar switch). */
    fun setAllProfiles(enabled: Boolean) {
        store.allProfiles = enabled
        _state.update { it.copy(allProfiles = enabled, sessionSearchResults = null, archivedSessions = emptyList()) }
        refreshSessions()
        if (_state.value.showArchived) loadArchivedSessions()
    }

    /** The profile the session lists are filtered by; null = all profiles. */
    private fun sessionsProfile(): String? =
        if (_state.value.allProfiles) _state.value.profileFilter.ifBlank { null } else _state.value.activeProfile.ifBlank { "default" }

    // ── conversation ──────────────────────────────────────────────────────

    /** Open an existing Studio conversation and load its history. */
    fun openSession(session: SessionSummary) {
        cancelActiveRun(abort = false)
        historyJob?.cancel()
        val profile = session.profile?.ifBlank { null }
            ?: _state.value.activeProfile.ifBlank { "default" }
        store.setSessionFor(profile, session.id)
        _state.update {
            val runtime = runtimeForSession(session)
            it.copy(
                screen = Screen.Conversation,
                openSession = session,
                unreadSessionIds = it.unreadSessionIds - session.id,
                sessionModel = session.model,
                sessionProvider = session.provider,
                contextTokens = 0,
                contextWindow = 0,
                loadingContext = true,
                lines = emptyList(),
                attachments = emptyList(),
                models = if (it.modelsProfile == profile) it.models else emptyList(),
                modelsProfile = it.modelsProfile.takeIf { loaded -> loaded == profile },
                loadingHistory = true,
                error = null,
                notice = null,
                selectedRuntime = runtime,
                pendingRunAction = null,
                compression = null,
                abortPhase = null,
                locationRequest = null,
                sessionPushEnabled = false,
            )
        }

        historyJob = viewModelScope.launch { loadLatestPage(session, profile) }
    }

    /**
     * The newest [HISTORY_PAGE] messages through the paginated endpoint.
     *
     * The server counts `offset` backwards from the newest message
     * (`ORDER BY id DESC LIMIT ? OFFSET ?` in session-store.ts and
     * sessions-db.ts, and the web passes its loaded count as the offset), so
     * offset 0 already *is* the latest page. The old second call with
     * `total - HISTORY_PAGE` fetched the oldest page instead, which is why a
     * long conversation opened on its first messages. Older pages arrive
     * through [loadOlderHistory] as the list is scrolled up.
     */
    private suspend fun loadLatestPage(session: SessionSummary, profile: String) {
        runCatching {
            withContext(Dispatchers.IO) {
                val page = api.conversationPage(session.id, 0, HISTORY_PAGE, profile)
                val window = runCatching { api.contextLength(profile, session.provider, session.model) }
                Triple(page, window.getOrDefault(0), window.exceptionOrNull())
            }
        }
            .onSuccess { (page, window, problem) ->
                _state.update { state ->
                    if (state.screen != Screen.Conversation || state.openSession?.id != session.id) {
                        return@update state
                    }
                    state.copy(
                        loadingHistory = false,
                        loadingContext = false,
                        error = problem?.readableMessage(localized),
                        // Live context arrives with `usage.updated`; the transcript alone does not carry it.
                        contextTokens = 0,
                        contextWindow = window,
                        historyOffset = page.fetched,
                        historyTotal = page.total,
                        historyHasMore = page.hasMore,
                        sessionPushEnabled = page.pushEnabled,
                        openSession = state.openSession?.copy(
                            title = page.title ?: state.openSession.title,
                            model = page.model ?: state.openSession.model,
                            workspace = page.workspace ?: state.openSession.workspace,
                            categoryId = page.categoryId ?: state.openSession.categoryId,
                        ),
                        lines = page.messages.map(::lineOf),
                    )
                }
            }
            .onFailure { failure ->
                if (failure is kotlinx.coroutines.CancellationException) return@onFailure
                // 404 means the conversation is gone on the server; showing
                // the raw "Session not found" as a banner is noise, and the
                // stale id must not be reused by the next send.
                if (failure.isMissingSession()) {
                    forgetMissingSession(profile, session.id)
                    return@onFailure
                }
                _state.update {
                    if (it.screen == Screen.Conversation && it.openSession?.id == session.id) {
                        it.copy(loadingHistory = false, loadingContext = false, error = failure.readableMessage(localized))
                    } else {
                        it
                    }
                }
            }
    }

    private fun lineOf(message: Message) = ChatLine(
        text = message.content,
        fromUser = message.fromUser,
        timestamp = message.timestamp,
        messageId = message.id,
        reasoning = message.reasoning,
        system = message.role == "system",
        command = message.role == "command",
    )

    /**
     * Infinite scroll towards older messages. `offset` counts backwards from
     * the newest message, so the next page starts where the loaded window
     * ends — the same arithmetic as the web's `loadOlderMessages`.
     */
    fun loadOlderHistory() {
        val session = _state.value.openSession ?: return
        val state = _state.value
        if (state.loadingOlderHistory || state.loadingHistory || !state.historyHasMore) return
        val profile = session.profile?.ifBlank { null } ?: currentProfile()
        val offset = state.historyOffset
        _state.update { it.copy(loadingOlderHistory = true) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.conversationPage(session.id, offset, HISTORY_PAGE, profile) } }
                .onSuccess { page ->
                    _state.update { current ->
                        if (current.openSession?.id != session.id) return@update current.copy(loadingOlderHistory = false)
                        val known = current.lines.mapNotNull { it.messageId }.toSet()
                        current.copy(
                            loadingOlderHistory = false,
                            historyOffset = offset + page.fetched,
                            historyHasMore = page.hasMore && page.fetched > 0,
                            lines = page.messages.filter { it.id !in known }.map(::lineOf) + current.lines,
                        )
                    }
                }
                .onFailure { failure -> _state.update { it.copy(loadingOlderHistory = false, error = failure.readableMessage(localized)) } }
        }
    }

    /** Reloads the open conversation without dropping the composer or flashing an empty screen. */
    fun refreshConversation() {
        val session = _state.value.openSession ?: return
        historyJob?.cancel()
        _state.update { it.copy(loadingHistory = true, loadingContext = true, error = null) }
        historyJob = viewModelScope.launch {
            val profile = session.profile?.ifBlank { null } ?: currentProfile()
            val previousContext = _state.value.contextTokens
            loadLatestPage(session, profile)
            // A reload must not wipe the live context figure the socket reported.
            _state.update { if (it.openSession?.id == session.id && it.contextTokens == 0L) it.copy(contextTokens = previousContext) else it }
        }
    }

    fun startNewConversation(runtime: AgentRuntimeSelection = AgentRuntimeSelection()) {
        cancelActiveRun(abort = false)
        historyJob?.cancel()
        historyJob = null
        val profile = _state.value.activeProfile.ifBlank { "default" }
        store.setSessionFor(profile, "")
        _state.update {
            it.copy(
                screen = Screen.Conversation,
                openSession = null,
                lines = emptyList(),
                attachments = emptyList(),
                sessionModel = null,
                sessionProvider = null,
                contextTokens = 0,
                contextWindow = 0,
                loadingContext = false,
                models = if (it.modelsProfile == profile) it.models else emptyList(),
                modelsProfile = it.modelsProfile.takeIf { loaded -> loaded == profile },
                error = null,
                notice = null,
                selectedRuntime = runtime,
                pendingRunAction = null,
                compression = null,
                abortPhase = null,
                locationRequest = null,
                sessionPushEnabled = false,
            )
        }
    }

    fun openAgentRuntimes() {
        _state.update { it.copy(screen = Screen.AgentRuntimes, loadingAgentRuntimes = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.agentRuntimes() } }
                .onSuccess { runtimes -> _state.update { it.copy(agentRuntimes = runtimes, loadingAgentRuntimes = false) } }
                .onFailure { failure ->
                    _state.update { it.copy(loadingAgentRuntimes = false, error = failure.readableMessage(localized)) }
                }
        }
    }

    fun startRuntimeConversation(runtime: AgentRuntimeStatus) {
        if (!runtime.installed) return
        startNewConversation(AgentRuntimeSelection(runtime.id, runtime.family, runtime.name))
    }

    /** Sends a generated Studio file to Android's public Downloads folder. */
    fun downloadChatFile(file: ChatFileLink, profile: String) {
        val application = getApplication<Application>()
        val destinationName = uniqueQueuedDownloadName(file.fileName)
        runCatching {
            val url = api.downloadUrl(file.path, file.fileName, profile.ifBlank { null })
            val extension = file.fileName.substringAfterLast('.', "").lowercase()
            val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
                ?: "application/octet-stream"
            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle(file.fileName)
                .setDescription(str(R.string.download_description, profile.ifBlank { "default" }))
                .setMimeType(mime)
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(true)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, destinationName)
            store.token.takeIf { it.isNotBlank() }
                ?.let { request.addRequestHeader("Authorization", "Bearer $it") }
            profile.takeIf { it.isNotBlank() }
                ?.let { request.addRequestHeader("X-Hermes-Profile", it) }
            val manager = application.getSystemService(DownloadManager::class.java)
                ?: error("DownloadManager unavailable")
            manager.enqueue(request)
        }.onSuccess {
            _state.update {
                it.copy(notice = str(R.string.download_started, destinationName), error = null)
            }
        }.onFailure { failure ->
            queuedDownloadNames.remove(destinationName)
            _state.update {
                it.copy(
                    error = str(R.string.download_failed, failure.readableMessage(localized)),
                    notice = null,
                )
            }
        }
    }

    fun send(message: String) {
        val text = message.trim()
        val files = _state.value.attachments
        if ((text.isEmpty() && files.isEmpty()) || _state.value.sending) return
        val session = _state.value.openSession
        val profile = session?.profile?.ifBlank { null }
            ?: _state.value.activeProfile.ifBlank { "default" }
        val selectedModel = _state.value.sessionModel
        val selectedProvider = _state.value.sessionProvider
        val reasoningEffort = _state.value.reasoningEffort
        val wantsVoiceReply = _state.value.voiceReplyPending

        // Studio's own client names a conversation before it exists, which is
        // what lets the very first message belong to a session. The open
        // conversation wins over the stored id; a blank store means a new
        // chat, and the id minted here is the one the server will create.
        val sessionId = chatSessionIdFor(session?.id, store.sessionFor(profile))
            ?: java.util.UUID.randomUUID().toString().also { store.setSessionFor(profile, it) }

        val echo = if (files.isEmpty()) text else {
            listOf(text.ifBlank { null }, files.joinToString(", ") { "📎 " + it.name })
                .filterNotNull()
                .joinToString("\n")
        }
        _state.update {
            it.copy(
                lines = it.lines + ChatLine(echo, fromUser = true),
                sending = true,
                attachments = emptyList(),
                error = null,
                activity = null,
                voiceReplyPending = false,
            )
        }

        activeRunSessionId = sessionId
        runJob = viewModelScope.launch {
            var answer = StringBuilder()
            var thinking = StringBuilder()
            var streamed = false
            var finalReply = ""
            val runStartedAt = System.currentTimeMillis()

            fun ensureStreamingReply(startedAtMillis: Long = runStartedAt) {
                if (streamed) return
                streamed = true
                _state.update {
                    it.copy(
                        lines = it.lines + ChatLine(
                            text = "",
                            fromUser = false,
                            streaming = true,
                            startedAtMillis = startedAtMillis,
                        ),
                        activity = null,
                    )
                }
            }

            runCatching {
                chat.run(
                    profile = profile,
                    sessionId = sessionId,
                    input = text,
                    attachments = files,
                    reasoningEffort = reasoningEffort,
                    model = selectedModel,
                    provider = selectedProvider,
                    runtime = _state.value.selectedRuntime,
                    cachedPageId = resumePageIds[sessionId],
                )
                    .collect { event ->
                        when (event) {
                            is RunEvent.Started -> ensureStreamingReply(event.occurredAtMillis)
                            is RunEvent.Text -> {
                                answer.append(event.delta)
                                ensureStreamingReply()
                                updateLastReply(answer.toString(), thinking.toString(), streaming = true)
                            }
                            is RunEvent.Interim -> {
                                // The whole text so far; deltas may already have
                                // carried it, in which case nothing changes.
                                if (!event.alreadyStreamed || event.text.length > answer.length) {
                                    answer = StringBuilder(event.text)
                                    ensureStreamingReply()
                                    updateLastReply(answer.toString(), thinking.toString(), streaming = true)
                                }
                            }
                            is RunEvent.Reasoning -> {
                                thinking.append(event.delta)
                                ensureStreamingReply()
                                updateLastReply(answer.toString(), thinking.toString(), streaming = true)
                            }
                            is RunEvent.ReasoningAvailable -> {
                                thinking = StringBuilder(event.text)
                                ensureStreamingReply()
                                updateLastReply(answer.toString(), thinking.toString(), streaming = true)
                            }
                            is RunEvent.SettingsUpdated -> applySessionSettings(event)
                            is RunEvent.PeerUserMessage -> _state.update {
                                if (it.lines.any { line -> line.messageId != null && line.messageId == event.id }) it
                                else it.copy(lines = it.lines + ChatLine(event.content, fromUser = true, timestamp = event.timestamp, messageId = event.id))
                            }
                            is RunEvent.Compression -> _state.update {
                                it.copy(
                                    compression = CompressionStatus(
                                        running = event.started,
                                        messageCount = event.messageCount,
                                        beforeTokens = event.beforeTokens,
                                        afterTokens = event.afterTokens,
                                        error = event.error,
                                    ),
                                    contextTokens = if (!event.started && event.afterTokens != null) event.afterTokens else it.contextTokens,
                                )
                            }
                            is RunEvent.AbortPhase -> _state.update {
                                it.copy(
                                    abortPhase = if (event.phase == "completed") null else event.phase,
                                    lines = if (event.phase == "timeout" && !event.message.isNullOrBlank()) {
                                        it.lines + ChatLine(event.message, fromUser = false, system = true)
                                    } else it.lines,
                                )
                            }
                            is RunEvent.Command -> _state.update {
                                val text = event.message.ifBlank { event.command }
                                if (text.isBlank()) it
                                else it.copy(lines = it.lines + ChatLine(text, fromUser = false, command = true, isError = !event.ok))
                            }
                            is RunEvent.TitleUpdated -> _state.update { state ->
                                state.copy(
                                    openSession = state.openSession?.let { open -> if (open.id == sessionId) open.copy(title = event.title) else open },
                                    sessions = state.sessions.map { s -> if (s.id == sessionId) s.copy(title = event.title) else s },
                                )
                            }
                            is RunEvent.WorkspaceUpdated -> _state.update { state ->
                                state.copy(openSession = state.openSession?.let { open -> if (open.id == sessionId) open.copy(workspace = event.workspace) else open })
                            }
                            is RunEvent.LocationRequested -> _state.update { it.copy(locationRequest = event.request) }
                            is RunEvent.MobileConsentRequested -> {
                                // TODO(M3): calendar, reminder and health integrations are
                                // not implemented on Android yet; the request is declined
                                // so the agent gets an answer instead of a timeout.
                                chat.denyMobileConsent(sessionId, event.capability, event.requestId, event.idKey)
                                _state.update { it.copy(notice = str(R.string.consent_unsupported, event.capability)) }
                            }
                            is RunEvent.Tool -> {
                                ensureStreamingReply()
                                updateLastTool(event)
                            }
                            is RunEvent.Usage -> _state.update {
                                it.copy(
                                    contextTokens = event.contextTokens,
                                    contextWindow = event.contextWindow ?: it.contextWindow,
                                )
                            }
                            is RunEvent.Done -> {
                                val output = event.output.ifBlank { answer.toString() }
                                finalReply = output
                                val reasoning = event.reasoning.ifBlank { thinking.toString() }
                                if (streamed) {
                                    updateLastReply(output, reasoning, streaming = false)
                                } else if (output.isNotBlank() || reasoning.isNotBlank()) {
                                    // A completion with neither text nor
                                    // reasoning has nothing to show; adding it
                                    // drew an avatar, an author label and a
                                    // timestamp around an empty bubble.
                                    _state.update {
                                        it.copy(
                                            lines = it.lines + ChatLine(
                                                text = output,
                                                fromUser = false,
                                                reasoning = reasoning.ifBlank { null },
                                            ),
                                        )
                                    }
                                }
                                streamed = true
                            }
                            is RunEvent.RequiresAction -> {
                                if (streamed) {
                                    updateLastReply(answer.toString(), thinking.toString(), streaming = false)
                                }
                                _state.update {
                                    it.copy(
                                        pendingRunAction = PendingRunAction(event.kind, event.id, event.prompt, event.options, sessionId),
                                        activity = null,
                                    )
                                }
                                streamed = true
                            }
                            is RunEvent.ActionResolved -> _state.update { state ->
                                if (state.pendingRunAction?.id != event.id) state
                                else if (event.resolved) state.copy(pendingRunAction = null, activity = null)
                                else state.copy(activity = null)
                            }
                            is RunEvent.QueueChanged -> _state.update {
                                it.copy(
                                    queuedRuns = event.messages ?: it.queuedRuns,
                                    queueInsertionActive = event.insertionActive ?: it.queueInsertionActive,
                                )
                            }
                            is RunEvent.BackgroundAgent -> _state.update { state ->
                                val tasks = state.backgroundAgentRuns.toMutableList()
                                val index = tasks.indexOfFirst { it.id == event.task.id }
                                if (index >= 0) tasks[index] = event.task else tasks += event.task
                                state.copy(backgroundAgentRuns = tasks)
                            }
                            is RunEvent.ResumedState -> {
                                event.pageId?.let { resumePageIds[sessionId] = it }
                                _state.update { state ->
                                    val restoredLines = event.messages?.mapNotNull { message ->
                                        when (message.role) {
                                            "user", "command" -> ChatLine(message.content, fromUser = true, messageId = message.id)
                                            "assistant" -> ChatLine(message.content, fromUser = false, reasoning = message.reasoning, messageId = message.id)
                                            else -> null
                                        }
                                    }
                                    state.copy(
                                        lines = restoredLines ?: state.lines,
                                        sessionModel = event.model ?: state.sessionModel,
                                        sessionProvider = event.provider ?: state.sessionProvider,
                                        reasoningEffort = event.reasoningEffort ?: state.reasoningEffort,
                                        openSession = state.openSession?.let { open ->
                                            if (open.id == sessionId && event.workspace != null) open.copy(workspace = event.workspace) else open
                                        },
                                        workspaceRunChanges = event.workspaceChanges.ifEmpty { state.workspaceRunChanges },
                                    )
                                }
                            }
                            is RunEvent.SessionGone -> {
                                updateLastReply(
                                    answer.toString(),
                                    thinking.toString(),
                                    streaming = false,
                                    terminalToolStatus = ToolRunStatus.Error,
                                )
                                forgetMissingSession(profile, sessionId)
                            }
                            is RunEvent.Failed -> {
                                // A socket that never got going is not a failed
                                // run: fall back to the REST wrapper instead of
                                // telling the user the answer is lost.
                                if (event.retryableTransport && !streamed) throw SocketUnavailable(event.error)
                                updateLastReply(
                                    answer.toString(),
                                    thinking.toString(),
                                    streaming = false,
                                    terminalToolStatus = ToolRunStatus.Error,
                                )
                                _state.update {
                                    it.copy(lines = withErrorLine(it.lines, event.error), error = event.error)
                                }
                            }
                        }
                    }
            }.onFailure { failure ->
                if (failure is kotlinx.coroutines.CancellationException) return@onFailure
                if (failure.isMissingSession()) {
                    forgetMissingSession(profile, sessionId)
                    finishRun(sessionId)
                    return@launch
                }
                if (failure is SocketUnavailable) {
                    sendOverRest(
                        profile = profile,
                        sessionId = sessionId,
                        text = text,
                        files = files,
                        reasoningEffort = reasoningEffort,
                        model = selectedModel,
                        provider = selectedProvider,
                        runtime = _state.value.selectedRuntime,
                        speakReply = wantsVoiceReply,
                    )
                    finishRun(sessionId)
                    return@launch
                }
                val message = failure.readableMessage(localized)
                _state.update { it.copy(lines = withErrorLine(it.lines, message), error = message) }
            }
            if ((wantsVoiceReply || _state.value.speakReplies) && finalReply.isNotBlank()) {
                val key = _state.value.lines.lastOrNull { !it.fromUser && !it.isError && !it.system && !it.command }?.key
                speakText(finalReply, key, profile)
            }
            finishRun(sessionId)
        }
    }

    /**
     * The server has no such conversation: the id was minted here and never
     * created, or it was deleted on the server while this phone still had it
     * in `Store.setSessionFor`, which survives restarts.
     *
     * Drop the stored id, take the conversation back to the neutral empty
     * state and say it once. No red row: the next send creates a session.
     */
    private fun forgetMissingSession(profile: String, sessionId: String) {
        if (store.sessionFor(profile) == sessionId) store.setSessionFor(profile, "")
        resumePageIds.remove(sessionId)
        _state.update { state ->
            val open = state.openSession?.id == sessionId
            state.copy(
                openSession = if (open) null else state.openSession,
                lines = if (open || state.openSession == null) emptyList() else state.lines,
                sessions = state.sessions.filterNot { it.id == sessionId },
                sessionSearchResults = state.sessionSearchResults?.filterNot { it.id == sessionId },
                unreadSessionIds = state.unreadSessionIds - sessionId,
                loadingHistory = false,
                loadingOlderHistory = false,
                loadingContext = false,
                historyOffset = 0,
                historyTotal = 0,
                historyHasMore = false,
                pendingRunAction = null,
                queuedRuns = emptyList(),
                backgroundAgentRuns = emptyList(),
                compression = null,
                abortPhase = null,
                locationRequest = null,
                sessionPushEnabled = false,
                error = null,
                notice = str(R.string.conversation_session_gone),
            )
        }
    }

    /** `session.settings.updated`: the server changed the pills' values (from any client). */
    private fun applySessionSettings(event: RunEvent.SettingsUpdated) {
        event.reasoningEffort?.let { store.reasoningEffort = it }
        _state.update {
            it.copy(
                sessionModel = event.model ?: it.sessionModel,
                sessionProvider = event.provider ?: it.sessionProvider,
                reasoningEffort = event.reasoningEffort ?: it.reasoningEffort,
                sessionPushEnabled = event.pushEnabled ?: it.sessionPushEnabled,
            )
        }
    }

    // ── composer ⚙ menu ───────────────────────────────────────────────────

    fun setShowToolCalls(enabled: Boolean) {
        store.showToolCalls = enabled
        _state.update { it.copy(showToolCalls = enabled) }
    }

    fun setSpeakReplies(enabled: Boolean) {
        store.speakReplies = enabled
        if (!enabled) stopSpeaking()
        _state.update { it.copy(speakReplies = enabled) }
    }

    /** Composer ⚙ → Push: completion messages for this session go to the push channel. */
    fun togglePushEnabled() {
        val sessionId = _state.value.openSession?.id ?: run {
            _state.update { it.copy(notice = str(R.string.push_needs_session)) }
            return
        }
        val next = !_state.value.sessionPushEnabled
        val profile = _state.value.openSession?.profile?.ifBlank { null } ?: currentProfile()
        _state.update { it.copy(sessionPushEnabled = next) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.setSessionPushEnabled(sessionId, next) } }
                .onFailure { failure ->
                    if (failure.isMissingSession()) forgetMissingSession(profile, sessionId)
                    else _state.update { it.copy(sessionPushEnabled = !next, error = failure.readableMessage(localized)) }
                }
        }
    }

    // ── queued runs ───────────────────────────────────────────────────────

    fun steerQueuedRun(queueId: String) {
        val sessionId = activeRunSessionId ?: _state.value.openSession?.id ?: return
        chat.steerQueuedRun(sessionId, queueId)
    }

    // ── mobile consent (location) ─────────────────────────────────────────

    /**
     * The user answered the location consent dialog. On consent the fix is read
     * with the platform LocationManager (permission already granted by the UI)
     * and sent as `location.respond`; a refusal is reported as `denied`.
     */
    fun respondToLocation(granted: Boolean) {
        val request = _state.value.locationRequest ?: return
        _state.update { it.copy(locationRequest = null) }
        if (!granted) {
            deliverLocation(request, LocationResult.Denied)
            return
        }
        viewModelScope.launch {
            val app = getApplication<Application>()
            val precise = request.accuracy == "precise"
            val result = runCatching { MobileLocation.currentFix(app, precise, request.timeoutMs) }
                .getOrElse { LocationResult.Error("location_failed") }
            deliverLocation(request, result)
        }
    }

    /** The runtime permission was refused: tell the agent instead of leaving it waiting. */
    fun reportLocationPermissionDenied() {
        val request = _state.value.locationRequest ?: return
        _state.update { it.copy(locationRequest = null) }
        deliverLocation(request, LocationResult.Error("location_permission_denied"))
    }

    private fun deliverLocation(request: LocationRequest, result: LocationResult) {
        val sent = chat.respondToLocation(locationResponsePayload(request.sessionId, request.id, result))
        val notice = when {
            !sent -> str(R.string.location_reply_lost)
            result is LocationResult.Success -> str(R.string.location_shared)
            result is LocationResult.Denied -> str(R.string.location_denied_notice)
            else -> str(R.string.location_failed_notice)
        }
        _state.update { if (sent && result is LocationResult.Success) it.copy(notice = notice) else it.copy(error = notice) }
    }

    // ── inline media ──────────────────────────────────────────────────────

    /** Where an inline player streams a chat file from, and the headers it must send. */
    fun mediaSource(file: ChatFileLink, profile: String): Pair<String, Map<String, String>> =
        api.streamUrl(file.path, file.fileName, profile.ifBlank { null }) to api.mediaHeaders(profile.ifBlank { null })

    fun resolveRunAction(response: String) {
        val action = _state.value.pendingRunAction ?: return
        if (response.isBlank()) return
        when (action.kind) {
            RequiredAction.Approval -> chat.respondToApproval(action.sessionId, action.id, response)
            RequiredAction.Clarification -> chat.respondToClarification(action.sessionId, action.id, response)
        }
        _state.update { it.copy(activity = str(R.string.run_action_resuming)) }
    }

    fun insertQueuedRun(queueId: String) {
        val sessionId = activeRunSessionId ?: _state.value.openSession?.id ?: return
        chat.insertQueuedRun(sessionId, queueId)
    }

    fun cancelQueuedRun(queueId: String) {
        val sessionId = activeRunSessionId ?: _state.value.openSession?.id ?: return
        chat.cancelQueuedRun(sessionId, queueId)
    }

    /** Older servers, or a blocked WebSocket, still answer over plain HTTP. */
    private suspend fun sendOverRest(
        profile: String,
        sessionId: String,
        text: String,
        files: List<Upload>,
        reasoningEffort: String?,
        model: String?,
        provider: String?,
        runtime: AgentRuntimeSelection,
        speakReply: Boolean = false,
    ) {
        runCatching {
            withContext(Dispatchers.IO) {
                api.sendMessage(
                    profile = profile,
                    input = text,
                    sessionId = sessionId,
                    attachments = files,
                    reasoningEffort = reasoningEffort,
                    model = model,
                    provider = provider,
                    runtime = runtime,
                )
            }
        }.onSuccess { reply ->
            if (activeRunSessionId != sessionId) return@onSuccess
            reply.sessionId?.let { store.setSessionFor(profile, it) }
            val line = when {
                reply.error != null && reply.output.isBlank() ->
                    ChatLine(reply.error, fromUser = false, isError = true)
                // Nothing to draw: no empty bubble, as on the socket path.
                reply.output.isBlank() && reply.reasoning.isNullOrBlank() -> null
                else -> ChatLine(reply.output, fromUser = false, reasoning = reply.reasoning)
            }
            _state.update {
                it.copy(
                    lines = if (line == null) it.lines else it.lines + line,
                    sending = false,
                    activity = null,
                )
            }
            if (speakReply && line != null && !line.isError && line.text.isNotBlank()) speak(line.text, profile)
        }.onFailure { failure ->
            if (failure is kotlinx.coroutines.CancellationException || activeRunSessionId != sessionId) {
                return@onFailure
            }
            if (failure.isMissingSession()) {
                forgetMissingSession(profile, sessionId)
                _state.update { it.copy(sending = false, activity = null) }
                return@onFailure
            }
            val message = failure.readableMessage(localized)
            _state.update {
                it.copy(lines = withErrorLine(it.lines, message), error = message, sending = false, activity = null)
            }
        }
    }

    private fun runtimeForSession(session: SessionSummary): AgentRuntimeSelection {
        val id = when (session.agentId?.lowercase()) {
            "ekko", "ekko-agent" -> "ekko-agent"
            "claude", "claude-code" -> "claude-code"
            "codex" -> "codex"
            "pi" -> "pi"
            else -> "hermes"
        }
        val family = when (id) { "hermes" -> "hermes"; "ekko-agent" -> "ekko"; else -> "coding" }
        val global = session.source == "global_agent"
        val name = if (global) "Global Agent" else when (id) { "hermes" -> "Hermes"; "ekko-agent" -> "Ekko"; "claude-code" -> "Claude Code"; "codex" -> "Codex"; else -> "Pi" }
        return AgentRuntimeSelection(id, family, name, global)
    }

    private fun updateLastReply(
        text: String,
        reasoning: String,
        streaming: Boolean,
        terminalToolStatus: ToolRunStatus = ToolRunStatus.Done,
    ) {
        _state.update { state ->
            val lines = state.lines.toMutableList()
            val index = lines.indexOfLast { !it.fromUser && !it.isError }
            if (index < 0) return@update state
            val now = System.currentTimeMillis()
            val current = lines[index]
            if (!streaming && text.isBlank() && reasoning.isBlank() && current.tools.isEmpty()) {
                lines.removeAt(index)
                return@update state.copy(lines = lines)
            }
            lines[index] = lines[index].copy(
                text = text,
                reasoning = reasoning.ifBlank { null },
                streaming = streaming,
                finishedAtMillis = if (streaming) null else now,
                // Thinking is "observed" until the first answer text (or the end).
                thinkingFinishedAtMillis = current.thinkingFinishedAtMillis ?: if (text.isNotBlank() || !streaming) now else null,
                tools = if (streaming) {
                    current.tools
                } else {
                    current.tools.map { tool ->
                        if (tool.status != ToolRunStatus.Running) tool else tool.copy(
                            status = terminalToolStatus,
                            durationSeconds = tool.durationSeconds
                                ?: ((now - tool.startedAtMillis).coerceAtLeast(0) / 1000.0),
                        )
                    }
                },
            )
            state.copy(lines = lines)
        }
    }

    private fun updateLastTool(event: RunEvent.Tool) {
        _state.update { state ->
            val lines = state.lines.toMutableList()
            val lineIndex = lines.indexOfLast { !it.fromUser && !it.isError }
            if (lineIndex < 0) return@update state
            val line = lines[lineIndex]
            val tools = line.tools.toMutableList()
            val matchingIndex = when {
                event.id.isNotBlank() -> tools.indexOfLast { it.id == event.id }
                event.status != ToolRunStatus.Running -> tools.indexOfLast {
                    it.status == ToolRunStatus.Running && it.name == event.name
                }
                else -> -1
            }

            if (matchingIndex >= 0) {
                val current = tools[matchingIndex]
                tools[matchingIndex] = current.copy(
                    name = event.name.ifBlank { current.name },
                    detail = current.detail ?: event.detail,
                    status = event.status,
                    durationSeconds = event.durationSeconds ?: if (event.status == ToolRunStatus.Running) {
                        current.durationSeconds
                    } else {
                        (event.occurredAtMillis - current.startedAtMillis).coerceAtLeast(0) / 1000.0
                    },
                    arguments = event.arguments ?: current.arguments,
                    output = event.output ?: current.output,
                    outputTruncated = event.outputTruncated || current.outputTruncated,
                    outputOriginalLength = event.outputOriginalLength ?: current.outputOriginalLength,
                    reasoning = event.reasoning ?: current.reasoning,
                )
            } else {
                val fallbackDuration = event.durationSeconds
                val startedAt = if (fallbackDuration != null) {
                    event.occurredAtMillis - (fallbackDuration * 1000).toLong()
                } else {
                    event.occurredAtMillis
                }
                tools += ChatToolStep(
                    id = event.id.ifBlank { "${event.name}-${event.occurredAtMillis}" },
                    name = event.name,
                    detail = event.detail,
                    status = event.status,
                    startedAtMillis = startedAt,
                    durationSeconds = fallbackDuration,
                    arguments = event.arguments,
                    output = event.output,
                    outputTruncated = event.outputTruncated,
                    outputOriginalLength = event.outputOriginalLength,
                    reasoning = event.reasoning,
                )
            }

            lines[lineIndex] = line.copy(tools = tools)
            val active = tools.lastOrNull { it.status == ToolRunStatus.Running }?.name
            state.copy(lines = lines, activity = active)
        }
    }

    /** Asks the server to stop the run that is streaming right now. */
    fun stopRun() {
        cancelActiveRun(abort = true)
    }

    private fun cancelActiveRun(abort: Boolean) {
        val sessionId = activeRunSessionId
        if (abort && !sessionId.isNullOrBlank()) chat.abort(sessionId)
        runJob?.cancel()
        runJob = null
        activeRunSessionId = null
        _state.update { state ->
            val lines = state.lines.toMutableList()
            val index = lines.indexOfLast { it.streaming }
            if (index >= 0) {
                val now = System.currentTimeMillis()
                lines[index] = lines[index].copy(
                    streaming = false,
                    finishedAtMillis = now,
                    tools = lines[index].tools.map { tool ->
                        if (tool.status != ToolRunStatus.Running) tool else tool.copy(
                            status = ToolRunStatus.Error,
                            durationSeconds = (now - tool.startedAtMillis).coerceAtLeast(0) / 1000.0,
                        )
                    },
                )
            }
            state.copy(lines = lines, sending = false, activity = null, abortPhase = null, locationRequest = null)
        }
    }

    private fun finishRun(sessionId: String) {
        if (activeRunSessionId != sessionId) return
        activeRunSessionId = null
        runJob = null
        _state.update {
            // A reply that landed while another screen was open earns the
            // unread dot in the session list, as in the web sidebar.
            val away = it.screen != Screen.Conversation || it.openSession?.id != sessionId
            it.copy(
                sending = false,
                activity = null,
                abortPhase = null,
                locationRequest = null,
                compression = it.compression?.takeIf { c -> !c.running },
                unreadSessionIds = if (away) it.unreadSessionIds + sessionId else it.unreadSessionIds,
            )
        }
    }

    fun dismissCompression() = _state.update { it.copy(compression = null) }

    private class SocketUnavailable(message: String) : Exception(message)

    // ── attachments ───────────────────────────────────────────────────────

    private val uploadJobs = mutableMapOf<String, Job>()

    /**
     * Uploads the picked file through the chunked App upload
     * (`/api/studio/app-uploads`, 256 KiB PUTs, 50 MB max) with a progress chip
     * the user can cancel. A server that predates the route (404) falls back to
     * the multipart `/upload`.
     */
    fun attach(bytes: ByteArray, filename: String, mime: String) {
        val profile = currentProfile()
        if (bytes.size.toLong() > AppUploads.MAX_BYTES) {
            _state.update { it.copy(error = str(R.string.upload_too_large, filename)) }
            return
        }
        val id = AppUploads.newId()
        _state.update {
            it.copy(
                attaching = true,
                error = null,
                uploads = it.uploads + UploadProgress(id, filename, 0, bytes.size.toLong()),
            )
        }
        uploadJobs[id] = viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val session = try {
                        api.openAppUpload(profile, id, filename, bytes.size.toLong())
                    } catch (failure: HermesException) {
                        if (failure.statusCode == 404) return@withContext api.upload(profile, bytes, filename, mime)
                        throw failure
                    }
                    var offset = session.nextOffset
                    for (chunk in planUploadChunks(bytes.size.toLong(), session.maxChunkBytes, session.nextOffset)) {
                        ensureActive()
                        val start = chunk.offset.toInt()
                        offset = api.appendAppUploadChunk(profile, id, chunk.offset, bytes.copyOfRange(start, start + chunk.length))
                        _state.update { state ->
                            state.copy(uploads = state.uploads.map { u -> if (u.id == id) u.copy(sent = offset) else u })
                        }
                    }
                    api.completeAppUpload(profile, id, mime, filename)
                }
            }.onSuccess { upload ->
                _state.update {
                    val remaining = it.uploads.filterNot { u -> u.id == id }
                    it.copy(attaching = remaining.isNotEmpty(), uploads = remaining, attachments = it.attachments + upload)
                }
            }.onFailure { failure ->
                if (failure is kotlinx.coroutines.CancellationException) {
                    // Cancelled from the chip: let the server drop the partial file.
                    viewModelScope.launch(Dispatchers.IO) { runCatching { api.abortAppUpload(profile, id) } }
                    _state.update {
                        val remaining = it.uploads.filterNot { u -> u.id == id }
                        it.copy(attaching = remaining.isNotEmpty(), uploads = remaining)
                    }
                    return@onFailure
                }
                _state.update {
                    val remaining = it.uploads.filterNot { u -> u.id == id }
                    it.copy(attaching = remaining.isNotEmpty(), uploads = remaining, error = failure.readableMessage(localized))
                }
            }
            uploadJobs.remove(id)
        }
    }

    /** The content resolver returned nothing for a picked file: say so instead of dropping it silently. */
    fun reportAttachmentUnreadable(name: String) = _state.update { it.copy(error = str(R.string.upload_unreadable, name)) }

    fun cancelUpload(id: String) {
        uploadJobs.remove(id)?.cancel()
        _state.update {
            val remaining = it.uploads.filterNot { u -> u.id == id }
            it.copy(attaching = remaining.isNotEmpty(), uploads = remaining)
        }
    }

    fun removeAttachment(upload: Upload) {
        _state.update { it.copy(attachments = it.attachments - upload) }
    }

    // ── voice ─────────────────────────────────────────────────────────────

    /** Settings → Voice: where speech becomes text. */
    fun setVoiceInput(mode: String) {
        val clean = if (mode == Store.VOICE_INPUT_SERVER) Store.VOICE_INPUT_SERVER else Store.VOICE_INPUT_DEVICE
        store.voiceInput = clean
        _state.update { it.copy(voiceInput = clean) }
    }

    /**
     * Starts dictation. On-device recognition is the default and streams text
     * live; the Core Hub server path records a WAV and transcribes it after the
     * take. When the device has no recognizer the server path is used and the
     * user is told so.
     */
    fun startVoiceInput() {
        val current = _state.value.voice
        if (current == VoiceStatus.Listening || current == VoiceStatus.Transcribing) return
        val app = getApplication<Application>()
        val wantsServer = _state.value.voiceInput == Store.VOICE_INPUT_SERVER
        val available = SpeechInput.isAvailable(app)
        if (wantsServer || !available) {
            if (!wantsServer) _state.update { it.copy(notice = str(R.string.notice_voice_fallback_server)) }
            startServerRecording()
        } else {
            startDeviceListening()
        }
    }

    /** Ends the take; the text arrives through the voice segment. */
    fun stopVoiceInput() {
        if (_state.value.voice != VoiceStatus.Listening) return
        if (_state.value.voiceViaServer) {
            stopRecordingAndTranscribe()
        } else {
            _state.update { it.copy(voice = VoiceStatus.Transcribing) }
            speech.stop()
        }
    }

    fun cancelVoiceInput() {
        if (_state.value.voiceViaServer) recorder.cancel() else speech.cancel()
        lastPartial = null
        emitVoiceSegment("", VoiceSegmentKind.Discard)
        _state.update { it.copy(voice = VoiceStatus.Idle) }
    }

    /** Clears the error state of the mic button after the message was seen. */
    fun resetVoice() = _state.update { if (it.voice == VoiceStatus.Error) it.copy(voice = VoiceStatus.Idle, error = null) else it }

    fun consumeVoiceSegment(serial: Long) = _state.update {
        if (it.voiceSegment?.serial == serial) it.copy(voiceSegment = null) else it
    }

    private fun startDeviceListening() {
        val languageTag = localized.resources.configuration.locales[0].toLanguageTag()
        lastPartial = null
        val started = speech.start(
            languageTag,
            object : SpeechInput.Listener {
                override fun onPartial(text: String) {
                    lastPartial = text
                    emitVoiceSegment(text, VoiceSegmentKind.Partial)
                }

                override fun onFinal(text: String) {
                    val spoken = text.ifBlank { lastPartial.orEmpty() }
                    lastPartial = null
                    if (spoken.isBlank()) {
                        emitVoiceSegment("", VoiceSegmentKind.Discard)
                        _state.update { it.copy(voice = VoiceStatus.Error, error = str(R.string.error_speech_no_match)) }
                        return
                    }
                    emitVoiceSegment(spoken, VoiceSegmentKind.Final)
                    _state.update { it.copy(voice = VoiceStatus.Idle, voiceReplyPending = true, error = null) }
                }

                override fun onError(code: Int) {
                    val partial = lastPartial
                    lastPartial = null
                    if (SpeechInput.isNoSpeech(code) && !partial.isNullOrBlank()) {
                        // The recognizer timed out after the user stopped talking; the
                        // last hypothesis is what they said.
                        emitVoiceSegment(partial, VoiceSegmentKind.Final)
                        _state.update { it.copy(voice = VoiceStatus.Idle, voiceReplyPending = true, error = null) }
                        return
                    }
                    if (!partial.isNullOrBlank()) emitVoiceSegment(partial, VoiceSegmentKind.Final)
                    else emitVoiceSegment("", VoiceSegmentKind.Discard)
                    _state.update { it.copy(voice = VoiceStatus.Error, error = speechErrorMessage(code)) }
                }
            },
        )
        if (!started) {
            _state.update { it.copy(notice = str(R.string.notice_voice_fallback_server)) }
            startServerRecording()
            return
        }
        _state.update { it.copy(voice = VoiceStatus.Listening, voiceViaServer = false, voiceSegment = null, error = null) }
    }

    private fun startServerRecording() {
        try {
            recorder.start()
        } catch (failure: Exception) {
            _state.update {
                it.copy(voice = VoiceStatus.Error, error = str(R.string.error_microphone_detail, failure.message ?: failure::class.java.simpleName))
            }
            return
        }
        _state.update { it.copy(voice = VoiceStatus.Listening, voiceViaServer = true, voiceSegment = null, error = null) }
    }

    /** Stops the take and turns it into text with the profile's STT provider. */
    private fun stopRecordingAndTranscribe() {
        val wav = recorder.stop()
        if (wav == null) {
            _state.update { it.copy(voice = VoiceStatus.Error, error = str(R.string.error_recording_short)) }
            return
        }
        val profile = currentProfile()
        val language = localized.resources.configuration.locales[0].language.takeIf { it.isNotBlank() }
        _state.update { it.copy(voice = VoiceStatus.Transcribing, error = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { api.transcribe(profile, wav, language) }
            }.onSuccess { result ->
                emitVoiceSegment(result.text, VoiceSegmentKind.Final)
                _state.update { it.copy(voice = VoiceStatus.Idle, voiceReplyPending = true) }
            }.onFailure { failure ->
                _state.update { it.copy(voice = VoiceStatus.Error, error = voiceErrorMessage(failure)) }
            }
        }
    }

    private fun emitVoiceSegment(text: String, kind: VoiceSegmentKind) {
        voiceSerial += 1
        val segment = VoiceSegment(text, kind, voiceSerial)
        _state.update { it.copy(voiceSegment = segment) }
    }

    private fun voiceErrorMessage(failure: Throwable): String = when {
        failure is SttNotConfiguredException -> str(R.string.error_stt_not_configured, failure.reason ?: "stt_not_configured")
        (failure as? HermesException)?.code == "no_speech_detected" -> str(R.string.error_speech_no_match)
        else -> failure.readableMessage(localized)
    }

    private fun speechErrorMessage(code: Int): String = when (code) {
        android.speech.SpeechRecognizer.ERROR_NO_MATCH,
        android.speech.SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
        -> str(R.string.error_speech_no_match)
        android.speech.SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> str(R.string.error_speech_permission)
        android.speech.SpeechRecognizer.ERROR_NETWORK,
        android.speech.SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
        android.speech.SpeechRecognizer.ERROR_SERVER,
        -> str(R.string.error_speech_network)
        android.speech.SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> str(R.string.error_speech_busy)
        android.speech.SpeechRecognizer.ERROR_AUDIO -> str(R.string.error_microphone)
        android.speech.SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED,
        android.speech.SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE,
        -> str(R.string.error_speech_language)
        else -> str(R.string.error_speech_generic, code)
    }

    private var speechJob: Job? = null
    private var deviceTts: android.speech.tts.TextToSpeech? = null
    private var deviceTtsReady = false

    fun stopSpeaking() {
        speechJob?.cancel()
        speechJob = null
        runCatching { speechPlayer?.stop() }
        runCatching { speechPlayer?.release() }
        speechPlayer = null
        runCatching { deviceTts?.stop() }
        _state.update { it.copy(speaking = false, speakingKey = null, speechPaused = false, speechLoadingKey = null) }
    }

    /**
     * The per-message play/pause button. Tapping the message being read pauses
     * or resumes it; tapping another one starts reading that message.
     */
    fun toggleSpeech(line: ChatLine, profile: String) {
        val key = line.key
        val current = _state.value
        if (current.speakingKey == key) {
            val player = speechPlayer
            if (player != null) {
                if (current.speechPaused) {
                    runCatching { player.start() }
                    _state.update { it.copy(speechPaused = false) }
                } else {
                    runCatching { player.pause() }
                    _state.update { it.copy(speechPaused = true) }
                }
            } else {
                // The device engine cannot pause; stop instead.
                stopSpeaking()
            }
            return
        }
        if (current.speechLoadingKey == key) {
            stopSpeaking()
            return
        }
        speakText(line.text, key, profile)
    }

    private fun speak(text: String, profile: String) = speakText(text, null, profile)

    /**
     * Reads [text] aloud: `POST /api/studio/tts/synthesize` on the server first;
     * when that fails (no provider, network, bad audio) the Android
     * TextToSpeech engine reads the same text so the reply is still heard.
     */
    private fun speakText(text: String, key: String?, profile: String) {
        stopSpeaking()
        val spoken = plainSpeechText(text)
        if (spoken.isBlank()) return
        _state.update { it.copy(speechLoadingKey = key) }
        speechJob = viewModelScope.launch {
            val synthesized = runCatching {
                withContext(Dispatchers.IO) {
                    val audio = api.synthesize(profile, spoken)
                    val file = java.io.File.createTempFile("hermes-reply-", audio.extension, getApplication<Application>().cacheDir)
                    file.writeBytes(audio.bytes)
                    file
                }
            }
            val file = synthesized.getOrNull()
            if (file == null) {
                val serverProblem = synthesized.exceptionOrNull()?.takeUnless { it is kotlinx.coroutines.CancellationException }
                if (serverProblem == null) return@launch
                speakOnDevice(spoken, key, serverProblem.readableMessage(localized))
                return@launch
            }
            runCatching {
                MediaPlayer().also { player ->
                    speechPlayer = player
                    player.setDataSource(file.absolutePath)
                    player.setOnPreparedListener { ready ->
                        runCatching { ready.start() }
                            .onSuccess { _state.update { it.copy(speaking = true, speakingKey = key, speechPaused = false, speechLoadingKey = null) } }
                            .onFailure { stopSpeaking(); file.delete(); speakOnDevice(spoken, key, str(R.string.voice_playback_failed)) }
                    }
                    player.setOnCompletionListener { finished ->
                        runCatching { finished.release() }
                        if (speechPlayer === finished) speechPlayer = null
                        file.delete()
                        _state.update { it.copy(speaking = false, speakingKey = null, speechPaused = false) }
                    }
                    player.setOnErrorListener { failed, _, _ ->
                        runCatching { failed.release() }
                        if (speechPlayer === failed) speechPlayer = null
                        file.delete()
                        speakOnDevice(spoken, key, str(R.string.voice_playback_failed))
                        true
                    }
                    player.prepareAsync()
                }
            }.onFailure {
                stopSpeaking()
                file.delete()
                speakOnDevice(spoken, key, str(R.string.voice_playback_failed))
            }
        }
    }

    /** Fallback: the platform engine. [reason] is shown as a notice so the user knows why. */
    private fun speakOnDevice(text: String, key: String?, reason: String) {
        val app = getApplication<Application>()
        fun start(engine: android.speech.tts.TextToSpeech) {
            val id = "core-hub-${System.currentTimeMillis()}"
            engine.setOnUtteranceProgressListener(object : android.speech.tts.UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = Unit
                override fun onDone(utteranceId: String?) {
                    if (utteranceId == id) _state.update { it.copy(speaking = false, speakingKey = null, speechPaused = false) }
                }

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    if (utteranceId == id) _state.update { it.copy(speaking = false, speakingKey = null, error = str(R.string.voice_playback_failed)) }
                }
            })
            val queued = engine.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, id)
            if (queued == android.speech.tts.TextToSpeech.SUCCESS) {
                _state.update { it.copy(speaking = true, speakingKey = key, speechPaused = false, speechLoadingKey = null, notice = str(R.string.voice_device_fallback, reason)) }
            } else {
                _state.update { it.copy(speaking = false, speakingKey = null, speechLoadingKey = null, error = str(R.string.voice_playback_failed)) }
            }
        }
        val existing = deviceTts
        if (existing != null && deviceTtsReady) {
            start(existing)
            return
        }
        runCatching { deviceTts?.shutdown() }
        deviceTts = android.speech.tts.TextToSpeech(app) { status ->
            val engine = deviceTts
            if (status == android.speech.tts.TextToSpeech.SUCCESS && engine != null) {
                deviceTtsReady = true
                start(engine)
            } else {
                deviceTtsReady = false
                _state.update { it.copy(speaking = false, speakingKey = null, speechLoadingKey = null, error = str(R.string.voice_playback_failed)) }
            }
        }
    }

    override fun onCleared() {
        stopSpeaking()
        runCatching { deviceTts?.shutdown() }
        deviceTts = null
        super.onCleared()
    }

    // ── model and reasoning ───────────────────────────────────────────────

    fun loadModels() {
        val profile = currentProfile()
        val current = _state.value
        if (current.modelsProfile == profile && (current.models.isNotEmpty() || current.loadingModels)) return
        _state.update {
            it.copy(
                models = if (it.modelsProfile == profile) it.models else emptyList(),
                modelsProfile = profile,
                loadingModels = true,
            )
        }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.availableModels(profile) } }
                .onSuccess { models ->
                    _state.update {
                        if (it.modelsProfile == profile) it.copy(models = models, loadingModels = false) else it
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        if (it.modelsProfile == profile) {
                            it.copy(loadingModels = false, error = failure.readableMessage(localized))
                        } else {
                            it
                        }
                    }
                }
        }
    }

    /**
     * Applies a model to the open session, or remembers it for the next one.
     *
     * Only a conversation the server already knows can be written to. The
     * stored id of a chat that has not sent its first message yet exists only
     * on this phone, so `PUT /sessions/{id}/model` answered 404 "Session not
     * found" and a brand-new chat opened with an error banner.
     */
    fun selectModel(option: ModelOption) {
        val sessionId = _state.value.openSession?.id?.takeIf { it.isNotBlank() }
        _state.update {
            it.copy(
                sessionModel = option.id,
                sessionProvider = option.provider,
                loadingContext = true,
            )
        }
        viewModelScope.launch {
            val profile = currentProfile()
            val length = runCatching {
                withContext(Dispatchers.IO) { api.contextLength(profile, option.provider, option.id) }
            }.getOrDefault(0)
            _state.update {
                if (it.sessionModel == option.id && it.sessionProvider == option.provider) {
                    it.copy(
                        contextWindow = length.takeIf { value -> value > 0 } ?: it.contextWindow,
                        loadingContext = false,
                    )
                } else it
            }
        }
        if (sessionId == null) return

        val profile = currentProfile()
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { api.setSessionModel(sessionId, option.id, option.provider) }
            }.onFailure { failure ->
                if (failure.isMissingSession()) forgetMissingSession(profile, sessionId)
                else _state.update { it.copy(error = failure.readableMessage(localized)) }
            }
        }
    }

    /** The 🧠 pill: the device default, and — when a conversation is open — the session's own setting on the server. */
    fun setReasoningEffort(effort: String) {
        store.reasoningEffort = effort
        _state.update { it.copy(reasoningEffort = effort) }
        val session = _state.value.openSession ?: return
        val profile = session.profile?.ifBlank { null } ?: currentProfile()
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.setSessionReasoningEffort(session.id, effort) } }
                .onFailure { failure ->
                    if (failure.isMissingSession()) forgetMissingSession(profile, session.id)
                    else _state.update { it.copy(error = failure.readableMessage(localized)) }
                }
        }
    }

    // ── group room ────────────────────────────────────────────────────────

    /** Opens a room: REST snapshot first (history), then the socket takes over. */
    fun openRoom(room: RoomInfo) {
        leaveRoom()
        openingRoomId = room.id
        _state.update {
            it.copy(screen = Screen.Room, openRoom = RoomState(room = room), loadingHistory = true, error = null, roomLive = false, roomAttachments = emptyList(), roomUploads = emptyList())
        }
        roomLoadJob = viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.room(room.id) } }
                .onSuccess { snapshot ->
                    if (_state.value.screen != Screen.Room || openingRoomId != room.id) return@onSuccess
                    _state.update { it.copy(openRoom = GroupRoomReducer.reduce(RoomState(room = snapshot.room), RoomEvent.Joined(snapshot)).copy(live = false), loadingHistory = false) }
                    listenToRoom(room.id)
                }
                .onFailure { failure ->
                    if (failure is kotlinx.coroutines.CancellationException) return@onFailure
                    _state.update {
                        if (it.screen == Screen.Room && openingRoomId == room.id) {
                            it.copy(loadingHistory = false, error = failure.readableMessage(localized))
                        } else {
                            it
                        }
                    }
                }
        }
    }

    /** Re-opens the room by id after a settings change (agents, workspace, name…). */
    private fun reopenRoom(roomId: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.room(roomId, limit = 1) } }
                .onSuccess { snapshot ->
                    _state.update { state ->
                        val open = state.openRoom?.takeIf { it.room.id == roomId } ?: return@update state
                        state.copy(openRoom = open.copy(room = snapshot.room.copy(agents = snapshot.agents), agents = snapshot.agents, members = snapshot.members, handoffs = snapshot.handoffs))
                    }
                    refreshRooms()
                }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    /** Keeps the open room current, and is what makes posting possible. */
    private fun listenToRoom(roomId: String) {
        roomJob?.cancel()
        val profile = _state.value.activeProfile.ifBlank { "default" }
        val name = _state.value.account ?: "phone"
        roomJob = viewModelScope.launch {
            runCatching {
                group.join(roomId, name, profile, _state.value.currentUser?.id).collect { event ->
                    _state.update { state ->
                        val open = state.openRoom?.takeIf { it.room.id == roomId } ?: return@update state
                        val next = GroupRoomReducer.reduce(open, event)
                        state.copy(
                            openRoom = next,
                            roomLive = next.live,
                            loadingOlderRoom = if (event is RoomEvent.HistoryLoaded || event is RoomEvent.Failed) false else state.loadingOlderRoom,
                            error = when (event) {
                                is RoomEvent.Failed -> event.error
                                RoomEvent.Kicked -> str(R.string.room_kicked)
                                else -> state.error
                            },
                        )
                    }
                    if (event is RoomEvent.Posted && event.message.isAgent && _state.value.speakReplies && event.message.content.isNotBlank()) {
                        speakRoomMessage(event.message)
                    }
                }
            }
        }
    }

    private fun speakRoomMessage(message: GroupMessage) {
        val line = ChatLine(text = message.content, fromUser = false, sender = message.senderName, messageId = message.id, timestamp = message.timestamp.toString())
        toggleSpeech(line, message.senderAgentProfile ?: _state.value.activeProfile.ifBlank { "default" })
    }

    fun leaveRoom() {
        openingRoomId = null
        roomLoadJob?.cancel()
        roomLoadJob = null
        roomJob?.cancel()
        roomJob = null
        roomUploadJobs.values.forEach { it.cancel() }
        roomUploadJobs.clear()
        _state.update { it.copy(roomLive = false, roomAttachments = emptyList(), roomUploads = emptyList(), loadingOlderRoom = false) }
    }

    /** Infinite scroll: the page before the oldest loaded message (socket when live, REST otherwise). */
    fun loadOlderRoomMessages() {
        val open = _state.value.openRoom ?: return
        if (_state.value.loadingOlderRoom || !open.hasMore) return
        val before = open.messages.firstOrNull()?.id ?: return
        _state.update { it.copy(loadingOlderRoom = true) }
        if (open.live && group.loadOlder(open.room.id, before)) return
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.room(open.room.id, before = before) } }
                .onSuccess { page ->
                    _state.update { state ->
                        val current = state.openRoom?.takeIf { it.room.id == open.room.id } ?: return@update state.copy(loadingOlderRoom = false)
                        state.copy(openRoom = GroupRoomReducer.reduce(current, RoomEvent.HistoryLoaded(page.messages, page.hasMore)), loadingOlderRoom = false)
                    }
                }
                .onFailure { failure -> _state.update { it.copy(loadingOlderRoom = false, error = failure.readableMessage(localized)) } }
        }
    }

    fun roomTyping(typing: Boolean) {
        val room = _state.value.openRoom ?: return
        group.typing(room.room.id, typing)
    }

    /** ⏹ next to a busy agent: `interrupt_agent`. */
    fun interruptRoomAgent(agentName: String) {
        val room = _state.value.openRoom ?: return
        if (!group.interrupt(room.room.id, agentName) { error -> if (error != null) _state.update { it.copy(error = error) } }) {
            _state.update { it.copy(error = str(R.string.error_room_offline)) }
        }
    }

    /** Answers an agent's approval or clarification card in the room. */
    fun respondRoomInteraction(interaction: RoomInteraction, response: String) {
        val room = _state.value.openRoom ?: return
        val sent = when (interaction.kind) {
            RequiredAction.Approval -> group.respondApproval(room.room.id, interaction.id, response) { error -> afterInteraction(interaction, error) }
            RequiredAction.Clarification -> group.respondClarify(room.room.id, interaction.id, response) { error -> afterInteraction(interaction, error) }
        }
        if (!sent) _state.update { it.copy(error = str(R.string.error_room_offline)) }
    }

    private fun afterInteraction(interaction: RoomInteraction, error: String?) {
        _state.update { state ->
            if (error != null) return@update state.copy(error = error)
            val open = state.openRoom ?: return@update state
            state.copy(openRoom = GroupRoomReducer.reduce(open, RoomEvent.InteractionResolved(interaction.kind, interaction.id)))
        }
    }

    fun cancelRoomQueueItem(item: QueueItem) {
        val room = _state.value.openRoom ?: return
        if (!group.cancelQueueItem(room.room.id, item.id) { error -> if (error != null) _state.update { it.copy(error = error) } }) {
            _state.update { it.copy(error = str(R.string.error_room_offline)) }
        }
    }

    // ── room settings ─────────────────────────────────────────────────────

    fun loadAgentPresets() {
        _state.update { it.copy(loadingPresets = true) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.agentPresets(null) } }
                .onSuccess { presets -> _state.update { it.copy(agentPresets = presets, loadingPresets = false) } }
                .onFailure { failure -> _state.update { it.copy(loadingPresets = false, error = failure.readableMessage(localized)) } }
        }
    }

    fun saveAgentPreset(id: String?, draft: RoomAgentDraft) = launchWork(
        work = { if (id == null) api.createAgentPreset(draft) else api.updateAgentPreset(id, draft) },
        onSuccess = { _state.update { it.copy(notice = str(R.string.preset_saved)) }; loadAgentPresets() },
    )

    fun deleteAgentPreset(preset: AgentPreset) = launchWork(
        work = { api.deleteAgentPreset(preset.id) },
        onSuccess = { _state.update { it.copy(agentPresets = it.agentPresets.filterNot { p -> p.id == preset.id }, notice = str(R.string.preset_deleted)) } },
    )

    fun addRoomAgent(draft: RoomAgentDraft) {
        val room = _state.value.openRoom ?: return
        launchWork(
            work = { api.addRoomAgent(room.room.id, draft) },
            onSuccess = { agent -> _state.update { it.copy(notice = str(R.string.room_agent_added, agent.name)) }; reopenRoom(room.room.id) },
        )
    }

    fun updateRoomAgent(agent: RoomAgent, draft: RoomAgentDraft) {
        val room = _state.value.openRoom ?: return
        launchWork(
            work = { api.updateRoomAgent(room.room.id, agent.id, draft) },
            onSuccess = { agents -> _state.update { it.copy(openRoom = it.openRoom?.copy(agents = agents), notice = str(R.string.notice_saved)) } },
        )
    }

    fun removeRoomAgent(agent: RoomAgent) {
        val room = _state.value.openRoom ?: return
        launchWork(
            work = { api.removeRoomAgent(room.room.id, agent.id) },
            onSuccess = { agents -> _state.update { it.copy(openRoom = it.openRoom?.copy(agents = agents), notice = str(R.string.room_agent_removed, agent.name)) }; refreshRooms() },
        )
    }

    fun removeRoomMember(member: RoomMember) {
        val room = _state.value.openRoom ?: return
        launchWork(
            work = { api.removeRoomMember(room.room.id, member.userId) },
            onSuccess = { members -> _state.update { it.copy(openRoom = it.openRoom?.copy(members = members), notice = str(R.string.room_member_removed, member.name)) } },
        )
    }

    fun renameRoom(name: String) {
        val room = _state.value.openRoom ?: return
        val clean = name.trim()
        if (clean.isBlank()) return
        launchWork(
            work = { api.updateRoomConfig(room.room.id, org.json.JSONObject().put("name", clean)) },
            onSuccess = { updated -> _state.update { it.copy(openRoom = it.openRoom?.copy(room = updated.copy(agents = it.openRoom?.agents.orEmpty())), notice = str(R.string.notice_saved)) }; refreshRooms() },
        )
    }

    /** Agent handoff settings (PUT /rooms/{id}/config). */
    fun setRoomHandoff(enabled: Boolean, maxDepth: Int?, unlimited: Boolean) {
        val room = _state.value.openRoom ?: return
        val body = org.json.JSONObject().put("agentHandoffEnabled", enabled).put("agentHandoffUnlimited", unlimited)
            .put("agentHandoffMaxDepth", maxDepth ?: org.json.JSONObject.NULL)
        launchWork(
            work = { api.updateRoomConfig(room.room.id, body) },
            onSuccess = { updated -> _state.update { it.copy(openRoom = it.openRoom?.copy(room = updated.copy(agents = it.openRoom?.agents.orEmpty())), notice = str(R.string.notice_saved)) } },
        )
    }

    fun setRoomWorkspace(workspace: String) {
        val room = _state.value.openRoom ?: return
        launchWork(
            work = { api.updateRoomWorkspace(room.room.id, workspace.trim()) },
            onSuccess = { updated -> _state.update { it.copy(openRoom = it.openRoom?.copy(room = updated.copy(agents = it.openRoom?.agents.orEmpty())), notice = str(R.string.notice_saved)) } },
        )
    }

    fun rotateRoomInviteCode() {
        val room = _state.value.openRoom ?: return
        val code = (1..6).map { INVITE_ALPHABET.random() }.joinToString("")
        launchWork(
            work = { api.updateRoomInviteCode(room.room.id, code) },
            onSuccess = { _state.update { it.copy(openRoom = it.openRoom?.copy(room = it.openRoom!!.room.copy(inviteCode = code)), notice = str(R.string.room_invite_updated)) } },
        )
    }

    /** The invite link the web shares: `{server}/group-chat/join/{code}`. */
    fun roomInviteLink(code: String): String = store.baseUrl.trimEnd('/') + "/group-chat/join/" + code

    fun clearRoomContext() {
        val room = _state.value.openRoom ?: return
        launchWork(
            work = { api.clearRoomContext(room.room.id) },
            onSuccess = { _state.update { it.copy(openRoom = it.openRoom?.let { open -> GroupRoomReducer.reduce(open, RoomEvent.RoomCleared(0L)) }, notice = str(R.string.room_context_cleared)) } },
        )
    }

    fun loadRoomSummary() {
        val room = _state.value.openRoom ?: return
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.roomSummary(room.room.id) } }
                .onSuccess { summary -> _state.update { it.copy(openRoom = it.openRoom?.copy(summary = summary)) } }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    fun saveRoomSummary(text: String) {
        val room = _state.value.openRoom ?: return
        launchWork(
            work = { api.updateRoomSummary(room.room.id, text) },
            onSuccess = { summary -> _state.update { it.copy(openRoom = it.openRoom?.copy(summary = summary ?: it.openRoom?.summary), notice = str(R.string.notice_saved)) } },
        )
    }

    fun continueRoomHandoff(chain: HandoffChain) {
        val room = _state.value.openRoom ?: return
        launchWork(
            work = { api.continueRoomHandoff(room.room.id, chain.chainId) },
            onSuccess = { updated ->
                _state.update { state ->
                    val open = state.openRoom ?: return@update state
                    state.copy(openRoom = updated?.let { GroupRoomReducer.reduce(open, RoomEvent.HandoffUpdated(it)) } ?: open, notice = str(R.string.room_handoff_continued))
                }
            },
        )
    }

    fun cloneRoom(room: RoomInfo, name: String?) {
        val code = (1..6).map { INVITE_ALPHABET.random() }.joinToString("")
        launchWork(
            work = { api.cloneRoom(room.id, name, code) },
            onSuccess = { created -> _state.update { it.copy(notice = str(R.string.room_cloned, created.name)) }; refreshRooms() },
        )
    }

    /** Join by code: resolve the room, then open it. */
    fun joinRoomByCode(code: String) {
        val clean = code.trim().substringAfterLast('/')
        if (clean.isBlank()) return
        launchWork(
            work = { api.joinRoomByCode(clean) },
            onSuccess = { room -> refreshRooms(); openRoom(room) },
        )
    }

    /** Attaches a file to the next room message through the room's chunked upload. */
    fun attachToRoom(bytes: ByteArray, filename: String, mime: String) {
        val room = _state.value.openRoom ?: return
        if (bytes.size.toLong() > AppUploads.MAX_BYTES) {
            _state.update { it.copy(error = str(R.string.upload_too_large, filename)) }
            return
        }
        val id = AppUploads.newId()
        val roomId = room.room.id
        _state.update { it.copy(error = null, roomUploads = it.roomUploads + UploadProgress(id, filename, 0, bytes.size.toLong())) }
        roomUploadJobs[id] = viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val session = try {
                        api.openRoomUpload(roomId, id, filename, bytes.size.toLong())
                    } catch (failure: HermesException) {
                        if (failure.statusCode == 404) return@withContext api.uploadRoomAttachment(roomId, bytes, filename, mime)
                        throw failure
                    }
                    var offset = session.nextOffset
                    for (chunk in planUploadChunks(bytes.size.toLong(), session.maxChunkBytes, session.nextOffset)) {
                        ensureActive()
                        val start = chunk.offset.toInt()
                        offset = api.appendRoomUploadChunk(roomId, id, chunk.offset, bytes.copyOfRange(start, start + chunk.length))
                        _state.update { state -> state.copy(roomUploads = state.roomUploads.map { u -> if (u.id == id) u.copy(sent = offset) else u }) }
                    }
                    api.completeRoomUpload(roomId, id, mime, filename)
                }
            }.onSuccess { upload ->
                _state.update { it.copy(roomUploads = it.roomUploads.filterNot { u -> u.id == id }, roomAttachments = it.roomAttachments + upload) }
            }.onFailure { failure ->
                if (failure is kotlinx.coroutines.CancellationException) {
                    viewModelScope.launch(Dispatchers.IO) { runCatching { api.abortRoomUpload(roomId, id) } }
                    _state.update { it.copy(roomUploads = it.roomUploads.filterNot { u -> u.id == id }) }
                    return@onFailure
                }
                _state.update { it.copy(roomUploads = it.roomUploads.filterNot { u -> u.id == id }, error = failure.readableMessage(localized)) }
            }
            roomUploadJobs.remove(id)
        }
    }

    fun cancelRoomUpload(id: String) { roomUploadJobs.remove(id)?.cancel() }

    fun removeRoomAttachment(upload: Upload) = _state.update { it.copy(roomAttachments = it.roomAttachments.filterNot { u -> u.path == upload.path }) }

    /** Stream URL and headers for a room attachment card. */
    fun roomAttachmentSource(attachment: GroupAttachment): Pair<String, Map<String, String>> {
        val room = _state.value.openRoom
        val url = when {
            attachment.url.startsWith("http") -> attachment.url
            attachment.url.startsWith("/") -> store.baseUrl.trimEnd('/') + attachment.url
            room != null -> api.roomAttachmentUrl(room.room.id, attachment.url.ifBlank { attachment.name })
            else -> attachment.url
        }
        return url to api.mediaHeaders(_state.value.activeProfile.ifBlank { null })
    }

    /** Saves a room attachment through DownloadManager, with the room's bearer token. */
    fun downloadRoomAttachment(attachment: GroupAttachment) {
        val (url, headers) = roomAttachmentSource(attachment)
        val destinationName = uniqueQueuedDownloadName(attachment.name.ifBlank { attachment.id })
        runCatching {
            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle(destinationName)
                .setMimeType(attachment.type.ifBlank { "application/octet-stream" })
                .setAllowedOverMetered(true)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, destinationName)
            headers.forEach { (name, value) -> request.addRequestHeader(name, value) }
            getApplication<Application>().getSystemService(DownloadManager::class.java)?.enqueue(request)
                ?: error("DownloadManager unavailable")
        }.onSuccess {
            _state.update { it.copy(notice = str(R.string.download_started, destinationName), error = null) }
        }.onFailure { failure ->
            queuedDownloadNames.remove(destinationName)
            _state.update { it.copy(error = str(R.string.download_failed, failure.readableMessage(localized)), notice = null) }
        }
    }

    // ── conversations ─────────────────────────────────────────────────────

    fun renameSession(session: SessionSummary, title: String) {
        val clean = title.trim()
        if (clean.isBlank()) return
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.renameSession(session.id, clean) } }
                .onSuccess {
                    _state.update { state ->
                        state.copy(
                            sessions = state.sessions.map {
                                if (it.id == session.id) it.copy(title = clean) else it
                            },
                            openSession = state.openSession?.takeIf { it.id == session.id }?.copy(title = clean)
                                ?: state.openSession,
                        )
                    }
                }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    fun deleteSession(session: SessionSummary) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.deleteSession(session.id) } }
                .onSuccess {
                    // Forget the pointer too, or the next message would try to
                    // continue a conversation the server no longer has.
                    session.profile?.let { profile ->
                        if (store.sessionFor(profile) == session.id) store.setSessionFor(profile, "")
                    }
                    _state.update { state ->
                        state.copy(sessions = state.sessions.filterNot { it.id == session.id })
                    }
                }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    // ── profiles ──────────────────────────────────────────────────────────

    fun createProfile(name: String) = profileWork(name) { api.createProfile(it) }

    fun renameProfile(from: String, to: String) = profileWork(to) { api.renameProfile(from, it) }

    fun deleteProfile(name: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.deleteProfile(name) } }
                .onSuccess {
                    if (store.profile == name) store.profile = ""
                    refreshProfiles()
                    _state.update { it.copy(notice = str(R.string.notice_profile_deleted, name)) }
                }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    private fun profileWork(name: String, block: suspend (String) -> Unit) {
        val clean = name.trim()
        if (clean.isBlank()) return
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { block(clean) } }
                .onSuccess { refreshProfiles() }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    // ── rooms ─────────────────────────────────────────────────────────────

    /** Creates a room with the given seats (the same body the web's CreateRoomForm posts) and opens it. */
    fun createRoom(name: String, agents: List<RoomAgentDraft>, workspace: String?) {
        val clean = name.trim()
        if (clean.isBlank()) return
        // Studio requires an invite code; one the user never has to think about
        // is better than a field they have to fill in. It can be rotated later.
        val code = (1..6).map { INVITE_ALPHABET.random() }.joinToString("")
        val summaryProfile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.createRoom(clean, code, agents, summaryProfile, workspace) } }
                .onSuccess { created ->
                    _state.update {
                        it.copy(
                            busy = false,
                            notice = str(R.string.notice_room_created, clean),
                            error = created.agentFailures.takeIf { f -> f.isNotEmpty() }?.let { f -> str(R.string.room_agents_failed, f.joinToString("، ")) },
                        )
                    }
                    refreshRooms()
                    openRoom(created.room)
                }
                .onFailure { failure ->
                    _state.update { it.copy(busy = false, error = failure.readableMessage(localized)) }
                }
        }
    }

    fun deleteRoom(room: RoomInfo) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.deleteRoom(room.id) } }
                .onSuccess {
                    _state.update { state ->
                        state.copy(
                            rooms = state.rooms.filterNot { it.id == room.id },
                            notice = str(R.string.room_deleted, room.name),
                            openRoom = state.openRoom?.takeUnless { it.room.id == room.id },
                        )
                    }
                    if (_state.value.screen == Screen.Room && _state.value.openRoom == null) back()
                }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    /** Sends into the open room over the socket the room screen holds, with any attached files. */
    fun postToRoom(text: String, mentionAll: Boolean = false): Boolean {
        val room = _state.value.openRoom ?: return false
        val clean = text.trim()
        val attachments = _state.value.roomAttachments
        if (clean.isBlank() && attachments.isEmpty()) return false
        val sent = group.post(room.room.id, clean, attachments, mentionAll) { error ->
            if (error != null) _state.update { it.copy(error = error) }
        }
        if (!sent) {
            _state.update { it.copy(error = str(R.string.error_room_offline)) }
        } else {
            _state.update { it.copy(roomAttachments = emptyList()) }
        }
        return sent
    }

    // ── native agent tools ───────────────────────────────────────────────

    fun openKanban() {
        _state.update { it.copy(screen = Screen.Kanban, error = null, notice = null) }
        loadKanban()
    }

    fun selectKanbanBoard(slug: String) {
        _state.update { it.copy(kanban = it.kanban.copy(board = slug, openTask = null)) }
        loadKanban(refreshBoards = false)
    }

    fun refreshKanban() = loadKanban()

    private fun loadKanban(refreshBoards: Boolean = true) {
        val old = _state.value.kanban
        _state.update { it.copy(kanban = it.kanban.copy(loading = true)) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val boards = if (refreshBoards || old.boards.isEmpty()) api.kanbanBoards() else old.boards
                    val selected = old.board.takeIf { slug -> boards.any { it.slug == slug } }
                        ?: boards.firstOrNull { it.isCurrent }?.slug
                        ?: boards.firstOrNull()?.slug.orEmpty()
                    Triple(boards, api.kanbanTasks(selected), api.kanbanAssignees(selected))
                }
            }.onSuccess { (boards, tasks, assignees) ->
                val selected = _state.value.kanban.board.takeIf { slug -> boards.any { it.slug == slug } }
                    ?: boards.firstOrNull { it.isCurrent }?.slug
                    ?: boards.firstOrNull()?.slug.orEmpty()
                _state.update {
                    it.copy(kanban = it.kanban.copy(
                        loading = false,
                        boards = boards,
                        board = selected,
                        tasks = tasks,
                        assignees = assignees,
                    ))
                }
            }.onFailure { failure ->
                _state.update {
                    it.copy(kanban = it.kanban.copy(loading = false), error = failure.readableMessage(localized))
                }
            }
        }
    }

    fun createKanbanTask(
        title: String,
        body: String,
        assignee: String,
        priority: Int,
        skills: List<String>,
        triage: Boolean,
    ) {
        val clean = title.trim()
        if (clean.isBlank()) return
        val board = _state.value.kanban.board
        _state.update { it.copy(kanban = it.kanban.copy(actionId = "new"), error = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    api.createKanbanTask(board, clean, body.trim(), assignee, priority, skills, triage)
                }
            }.onSuccess { task ->
                _state.update {
                    it.copy(
                        kanban = it.kanban.copy(actionId = null, tasks = it.kanban.tasks + task),
                        notice = str(R.string.kanban_created),
                    )
                }
            }.onFailure { failure ->
                _state.update {
                    it.copy(kanban = it.kanban.copy(actionId = null), error = failure.readableMessage(localized))
                }
            }
        }
    }

    fun moveKanbanTask(task: KanbanTask, status: String) {
        if (task.status == status) return
        val board = _state.value.kanban.board
        _state.update {
            it.copy(
                kanban = it.kanban.copy(
                    actionId = task.id,
                    tasks = it.kanban.tasks.map { current ->
                        if (current.id == task.id) current.copy(status = status) else current
                    },
                ),
                error = null,
            )
        }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.moveKanbanTask(board, task.id, status) } }
                .onSuccess {
                    _state.update { state -> state.copy(kanban = state.kanban.copy(actionId = null)) }
                    if (_state.value.screen == Screen.KanbanTask) loadKanbanTask(task.id)
                }
                .onFailure { failure ->
                    _state.update { state ->
                        state.copy(
                            kanban = state.kanban.copy(
                                actionId = null,
                                tasks = state.kanban.tasks.map { current ->
                                    if (current.id == task.id) task else current
                                },
                            ),
                            error = failure.readableMessage(localized),
                        )
                    }
                }
        }
    }

    fun openKanbanTask(task: KanbanTask) {
        _state.update {
            it.copy(
                screen = Screen.KanbanTask,
                kanban = it.kanban.copy(openTask = KanbanTaskDetail(task, null, emptyList(), emptyList())),
                error = null,
            )
        }
        loadKanbanTask(task.id)
        loadKanbanOperations(task.id)
    }

    private fun loadKanbanTask(id: String) {
        val board = _state.value.kanban.board
        _state.update { it.copy(kanban = it.kanban.copy(loading = true)) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.kanbanTask(board, id) } }
                .onSuccess { detail ->
                    _state.update {
                        it.copy(
                            kanban = it.kanban.copy(
                                loading = false,
                                openTask = detail,
                                tasks = it.kanban.tasks.map { task ->
                                    if (task.id == detail.task.id) detail.task else task
                                },
                            ),
                        )
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(kanban = it.kanban.copy(loading = false), error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun addKanbanComment(taskId: String, body: String) {
        val clean = body.trim()
        if (clean.isBlank()) return
        val board = _state.value.kanban.board
        _state.update { it.copy(kanban = it.kanban.copy(actionId = taskId), error = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { api.addKanbanComment(board, taskId, clean, _state.value.account) }
            }.onSuccess { loadKanbanTask(taskId) }
                .onFailure { failure ->
                    _state.update {
                        it.copy(kanban = it.kanban.copy(actionId = null), error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun assignKanbanTask(taskId: String, assignee: String) {
        val board = _state.value.kanban.board
        _state.update { it.copy(kanban = it.kanban.copy(actionId = taskId), error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.assignKanbanTask(board, taskId, assignee) } }
                .onSuccess { loadKanbanTask(taskId) }
                .onFailure { failure ->
                    _state.update {
                        it.copy(kanban = it.kanban.copy(actionId = null), error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun openSkills() {
        _state.update { it.copy(screen = Screen.Skills, error = null, notice = null) }
        loadSkills()
    }

    fun selectSkillsTarget(target: String) {
        _state.update { it.copy(skillsUi = it.skillsUi.copy(target = target, openSkill = null)) }
        loadSkills()
    }

    fun refreshSkills() = loadSkills()

    private fun loadSkills() {
        val profile = currentProfile()
        val target = _state.value.skillsUi.target
        _state.update { it.copy(skillsUi = it.skillsUi.copy(loading = true)) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.skills(profile, target) to api.pendingSkillWrites(profile) } }
                .onSuccess { (categories, pendingWrites) ->
                    _state.update { it.copy(skillsUi = it.skillsUi.copy(loading = false, resolvingWriteId = null, categories = categories, pendingWrites = pendingWrites)) }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(skillsUi = it.skillsUi.copy(loading = false, resolvingWriteId = null), error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun resolvePendingSkillWrite(id: String, approve: Boolean) {
        val profile = currentProfile()
        _state.update { it.copy(skillsUi = it.skillsUi.copy(resolvingWriteId = id), error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.resolvePendingSkillWrite(profile, id, approve) } }
                .onSuccess { loadSkills() }
                .onFailure { failure ->
                    _state.update { it.copy(skillsUi = it.skillsUi.copy(resolvingWriteId = null), error = failure.readableMessage(localized)) }
                }
        }
    }

    fun openSkill(category: String, skill: SkillInfo) {
        _state.update { it.copy(screen = Screen.Skill, skillsUi = it.skillsUi.copy(loading = true), error = null) }
        val profile = currentProfile()
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.skillContent(profile, category, skill.name) } }
                .onSuccess { content ->
                    _state.update {
                        it.copy(skillsUi = it.skillsUi.copy(loading = false, openSkill = OpenSkill(category, skill, content)))
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(skillsUi = it.skillsUi.copy(loading = false), error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun saveSkill(content: String) = mutateOpenSkill { profile, open ->
        api.saveSkill(profile, open.category, open.skill.name, content)
    }

    fun toggleSkill(skill: SkillInfo, enabled: Boolean) {
        val profile = currentProfile()
        _state.update { it.copy(skillsUi = it.skillsUi.copy(actionName = skill.name), error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.setSkillEnabled(profile, skill.name, enabled) } }
                .onSuccess {
                    updateSkill(skill.name) { it.copy(enabled = enabled) }
                    _state.update { it.copy(skillsUi = it.skillsUi.copy(actionName = null)) }
                }
                .onFailure { failure -> toolSkillFailure(failure) }
        }
    }

    fun pinSkill(skill: SkillInfo, pinned: Boolean) {
        val profile = currentProfile()
        _state.update { it.copy(skillsUi = it.skillsUi.copy(actionName = skill.name), error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.setSkillPinned(profile, skill.name, pinned) } }
                .onSuccess {
                    updateSkill(skill.name) { it.copy(pinned = pinned) }
                    _state.update { it.copy(skillsUi = it.skillsUi.copy(actionName = null)) }
                }
                .onFailure { failure -> toolSkillFailure(failure) }
        }
    }

    fun deleteOpenSkill() {
        val open = _state.value.skillsUi.openSkill ?: return
        val profile = currentProfile()
        _state.update { it.copy(skillsUi = it.skillsUi.copy(actionName = open.skill.name), error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.deleteSkill(profile, open.category, open.skill.name) } }
                .onSuccess {
                    _state.update { it.copy(screen = Screen.Skills, skillsUi = it.skillsUi.copy(openSkill = null, actionName = null)) }
                    loadSkills()
                }
                .onFailure { failure -> toolSkillFailure(failure) }
        }
    }

    fun importSkill(bytes: ByteArray, filename: String, category: String = "Imported") {
        val profile = currentProfile()
        _state.update { it.copy(skillsUi = it.skillsUi.copy(actionName = "import"), error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.importSkill(profile, category, bytes, filename) } }
                .onSuccess { name ->
                    _state.update {
                        it.copy(skillsUi = it.skillsUi.copy(actionName = null), notice = str(R.string.skills_imported, name))
                    }
                    loadSkills()
                }
                .onFailure { failure -> toolSkillFailure(failure) }
        }
    }

    private fun mutateOpenSkill(block: (String, OpenSkill) -> Unit) {
        val open = _state.value.skillsUi.openSkill ?: return
        val profile = currentProfile()
        _state.update { it.copy(skillsUi = it.skillsUi.copy(actionName = open.skill.name), error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { block(profile, open) } }
                .onSuccess {
                    _state.update {
                        it.copy(
                            skillsUi = it.skillsUi.copy(actionName = null, openSkill = open),
                            notice = str(R.string.skills_saved),
                        )
                    }
                }
                .onFailure { failure -> toolSkillFailure(failure) }
        }
    }

    private fun updateSkill(name: String, transform: (SkillInfo) -> SkillInfo) {
        _state.update { state ->
            val categories = state.skillsUi.categories.map { category ->
                category.copy(skills = category.skills.map { if (it.name == name) transform(it) else it })
            }
            val open = state.skillsUi.openSkill?.let {
                if (it.skill.name == name) it.copy(skill = transform(it.skill)) else it
            }
            state.copy(skillsUi = state.skillsUi.copy(categories = categories, openSkill = open))
        }
    }

    private fun toolSkillFailure(failure: Throwable) {
        _state.update {
            it.copy(skillsUi = it.skillsUi.copy(actionName = null), error = failure.readableMessage(localized))
        }
    }

    fun openPlugins() {
        _state.update { it.copy(screen = Screen.Plugins, error = null, notice = null) }
        loadPlugins()
    }

    fun refreshPlugins() = loadPlugins()

    private fun loadPlugins() {
        _state.update { it.copy(pluginsUi = it.pluginsUi.copy(loading = true)) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.plugins() } }
                .onSuccess { (plugins, warnings) ->
                    _state.update {
                        it.copy(pluginsUi = it.pluginsUi.copy(loading = false, plugins = plugins, warnings = warnings))
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(pluginsUi = it.pluginsUi.copy(loading = false), error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun togglePlugin(plugin: HermesPlugin, enabled: Boolean) {
        _state.update { it.copy(pluginsUi = it.pluginsUi.copy(actionKey = plugin.key), error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.setPluginEnabled(plugin.key, enabled) } }
                .onSuccess { loadPlugins() }
                .onFailure { failure ->
                    _state.update {
                        it.copy(pluginsUi = it.pluginsUi.copy(actionKey = null), error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun openMcp() {
        _state.update { it.copy(screen = Screen.Mcp, error = null, notice = null) }
        loadMcp()
    }

    fun refreshMcp() = loadMcp()

    private fun loadMcp() {
        _state.update { it.copy(mcpUi = it.mcpUi.copy(loading = true)) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.mcpServers() } }
                .onSuccess { servers ->
                    _state.update { it.copy(mcpUi = it.mcpUi.copy(loading = false, actionName = null, servers = servers)) }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(mcpUi = it.mcpUi.copy(loading = false, actionName = null), error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun saveMcpServer(originalName: String?, name: String, config: String) {
        if (name.isBlank()) return
        _state.update { it.copy(mcpUi = it.mcpUi.copy(actionName = originalName ?: "new"), error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.saveMcpServer(originalName, name.trim(), config) } }
                .onSuccess { loadMcp() }
                .onFailure { failure ->
                    _state.update {
                        it.copy(mcpUi = it.mcpUi.copy(actionName = null), error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun deleteMcpServer(name: String) = mutateMcp(name) { api.deleteMcpServer(name) }

    fun testMcpServer(name: String) = mutateMcp(name) { api.testMcpServer(name) }

    fun reloadMcpServer(name: String? = null) = mutateMcp(name ?: "all") { api.reloadMcpServer(name) }

    private fun mutateMcp(name: String, block: () -> Unit) {
        _state.update { it.copy(mcpUi = it.mcpUi.copy(actionName = name), error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { block() } }
                .onSuccess { loadMcp() }
                .onFailure { failure ->
                    _state.update {
                        it.copy(mcpUi = it.mcpUi.copy(actionName = null), error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun openPets() {
        _state.update { it.copy(screen = Screen.Pets, error = null, notice = null) }
        loadPets()
    }

    fun openInsights(days: Int = _state.value.usageDays) {
        _state.update { it.copy(screen = Screen.Insights, usageDays = days, loadingInsights = true, error = null) }
        refreshInsights(days)
    }

    fun refreshInsights(days: Int = _state.value.usageDays) {
        _state.update { it.copy(usageDays = days, loadingInsights = true, error = null) }
        viewModelScope.launch {
            val result = runCatching {
                withContext(Dispatchers.IO) { api.usageStats(days) to api.runtimePerformance() }
            }
            result.onSuccess { (usage, performance) ->
                _state.update { it.copy(usageStats = usage, runtimePerformance = performance, loadingInsights = false) }
            }.onFailure { failure ->
                _state.update { it.copy(loadingInsights = false, error = failure.readableMessage(localized)) }
            }
        }
    }

    fun refreshPets() = loadPets()

    private fun loadPets() {
        _state.update { it.copy(petsUi = it.petsUi.copy(loading = true)) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.petdex() to api.activePet() } }
                .onSuccess { (pets, active) ->
                    _state.update { it.copy(petsUi = it.petsUi.copy(loading = false, actionSlug = null, pets = pets, active = active)) }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(petsUi = it.petsUi.copy(loading = false, actionSlug = null), error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun adoptPet(slug: String) {
        _state.update { it.copy(petsUi = it.petsUi.copy(actionSlug = slug), error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.adoptPet(slug) } }
                .onSuccess { active ->
                    _state.update {
                        it.copy(petsUi = it.petsUi.copy(actionSlug = null, active = active), notice = str(R.string.pets_adopted))
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(petsUi = it.petsUi.copy(actionSlug = null), error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun setActivePet(enabled: Boolean? = null, scale: Double? = null) {
        val slug = _state.value.petsUi.active?.slug ?: return
        _state.update { it.copy(petsUi = it.petsUi.copy(actionSlug = slug), error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.updateActivePet(enabled, scale) } }
                .onSuccess { active ->
                    _state.update { it.copy(petsUi = it.petsUi.copy(actionSlug = null, active = active)) }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(petsUi = it.petsUi.copy(actionSlug = null), error = failure.readableMessage(localized))
                    }
                }
        }
    }

    // ── settings ──────────────────────────────────────────────────────────

    // ── settings groups ───────────────────────────────────────────────────

    fun openSettingsGroup(group: SettingsGroup) {
        _state.update {
            it.copy(
                screen = Screen.SettingsGroup,
                openGroup = group,
                toolReturnScreen = when (it.screen) {
                    Screen.AgentHub -> Screen.AgentHub
                    Screen.SettingsPage -> Screen.SettingsPage
                    else -> Screen.Settings
                },
                error = null,
                notice = null,
                loadingAgentSettings = group == SettingsGroup.Agent,
                loadingStudioSettings = group in STUDIO_CONFIG_GROUPS,
                loadingAccountSettings = group == SettingsGroup.Account,
                loadingManagedUsers = group == SettingsGroup.Users,
                loadingModelProviders = group == SettingsGroup.Models,
            )
        }
        loadSettingsGroup(group)
    }

    /** The tabbed Settings page (web tab order); [group] is the tab shown first. */
    fun openSettingsPage(group: SettingsGroup = SettingsGroup.Account) {
        _state.update { it.copy(screen = Screen.SettingsPage, error = null, notice = null) }
        selectSettingsTab(group)
    }

    /** Switches the Settings page tab in place and loads what that tab needs. */
    fun selectSettingsTab(group: SettingsGroup) {
        _state.update {
            it.copy(
                openGroup = group,
                error = null,
                loadingAgentSettings = group == SettingsGroup.Agent,
                loadingStudioSettings = group in STUDIO_CONFIG_GROUPS,
                loadingAccountSettings = group == SettingsGroup.Account,
                loadingManagedUsers = group == SettingsGroup.Users,
                loadingModelProviders = group == SettingsGroup.Models,
            )
        }
        loadSettingsGroup(group)
    }

    private fun loadSettingsGroup(group: SettingsGroup) {
        if (group == SettingsGroup.Agent) loadAgentSettings()
        if (group == SettingsGroup.Profile) loadModels()
        if (group in STUDIO_CONFIG_GROUPS) loadStudioSettings()
        if (group == SettingsGroup.Account) loadAccountSettings()
        if (group == SettingsGroup.Users) loadManagedUsers()
        if (group == SettingsGroup.Models) loadModelProviders()
    }

    private fun loadStudioSettings(showLoading: Boolean = true) {
        val profile = currentProfile()
        if (showLoading) _state.update { it.copy(loadingStudioSettings = true) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.studioSettings(profile) } }
                .onSuccess { settings ->
                    _state.update { it.copy(studioSettings = settings, loadingStudioSettings = false) }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(loadingStudioSettings = false, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    /** Saves a partial Studio config section so untouched keys remain unchanged. */
    fun setStudioValue(section: String, key: String, value: Any) {
        saveStudioSection(section, org.json.JSONObject().put(key, value))
    }

    fun saveProxy(https: String, http: String, all: String, noProxy: String) {
        saveStudioSection(
            "proxy",
            org.json.JSONObject()
                .put("HTTPS_PROXY", https.trim())
                .put("HTTP_PROXY", http.trim())
                .put("ALL_PROXY", all.trim())
                .put("NO_PROXY", noProxy.trim()),
        )
    }

    private fun saveStudioSection(section: String, values: org.json.JSONObject) {
        val profile = currentProfile()
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    // Studio restarts the gateway for proxy and protected-action
                    // approval changes so those values take effect immediately.
                    api.updateConfigSection(
                        profile,
                        section,
                        values,
                        restart = section == "proxy" || section == "approvals",
                    )
                }
            }.onSuccess {
                _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
                loadStudioSettings(showLoading = false)
            }.onFailure { failure ->
                _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
            }
        }
    }

    private fun loadAccountSettings() {
        _state.update { it.copy(loadingAccountSettings = true) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val user = api.currentUser()
                    AccountSettingsData(user, api.lockedIps(), api.myAvatar(user.username))
                }
            }.onSuccess { (user, locks, avatar) ->
                _state.update {
                    it.copy(
                        account = user.username,
                        currentUser = user,
                        lockedIps = locks,
                        accountAvatar = avatar,
                        loadingAccountSettings = false,
                    )
                }
            }.onFailure { failure ->
                _state.update {
                    it.copy(loadingAccountSettings = false, error = failure.readableMessage(localized))
                }
            }
        }
    }

    fun changeAccountPassword(currentPassword: String, newPassword: String) {
        accountWork { api.changePassword(currentPassword, newPassword) }
    }

    fun changeAccountUsername(currentPassword: String, newUsername: String) {
        accountWork {
            api.changeUsername(currentPassword, newUsername)
            loadAccountSettings()
        }
    }

    fun setAccountAvatar(bytes: ByteArray, mime: String) {
        if (mime !in setOf("image/png", "image/jpeg", "image/webp")) {
            _state.update { it.copy(error = str(R.string.account_avatar_invalid_type)) }
            return
        }
        if (bytes.size > 1024 * 1024) {
            _state.update { it.copy(error = str(R.string.account_avatar_too_large)) }
            return
        }
        accountWork {
            val encoded = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
            api.updateMyAvatar("data:$mime;base64,$encoded")
            loadAccountSettings()
        }
    }

    fun randomizeAccountAvatar() = accountWork {
        val seed = "${_state.value.account.orEmpty()}-${System.currentTimeMillis()}-${java.util.UUID.randomUUID()}"
        val svg = MultiAvatar.svg(getApplication(), seed)
        val encoded = android.util.Base64.encodeToString(svg.toByteArray(), android.util.Base64.NO_WRAP)
        api.updateMyAvatar("data:image/svg+xml;base64,$encoded", seed)
        loadAccountSettings()
    }

    fun resetAccountAvatar() = accountWork {
        api.resetMyAvatar()
        loadAccountSettings()
    }

    fun unlockIp(ip: String) = accountWork {
        api.unlockIp(ip)
        loadAccountSettings()
    }

    fun unlockAllIps() = accountWork {
        api.unlockAllIps()
        loadAccountSettings()
    }

    private fun accountWork(block: suspend () -> Unit) {
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { block() } }
                .onSuccess { _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) } }
                .onFailure { failure ->
                    _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
                }
        }
    }

    private fun loadManagedUsers() {
        _state.update { it.copy(loadingManagedUsers = true) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.managedUsers() } }
                .onSuccess { result ->
                    _state.update {
                        it.copy(
                            managedUsers = result.users,
                            managedProfiles = result.profiles,
                            loadingManagedUsers = false,
                        )
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(loadingManagedUsers = false, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun saveManagedUser(existingId: Int?, draft: ManagedUserDraft) {
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    if (existingId == null) api.createManagedUser(draft)
                    else api.updateManagedUser(existingId, draft)
                }
            }.onSuccess {
                _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
                loadManagedUsers()
            }.onFailure { failure ->
                _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
            }
        }
    }

    fun deleteManagedUser(user: ManagedUser) {
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.deleteManagedUser(user.id) } }
                .onSuccess {
                    _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
                    loadManagedUsers()
                }
                .onFailure { failure ->
                    _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
                }
        }
    }

    private fun loadModelProviders() {
        val profile = currentProfile()
        _state.update { it.copy(loadingModelProviders = true) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.modelCatalog(profile) } }
                .onSuccess { catalog ->
                    _state.update { it.copy(modelProviders = catalog.providers, modelCatalog = catalog, defaultModel = catalog.defaultModel.ifBlank { it.defaultModel }, loadingModelProviders = false) }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(loadingModelProviders = false, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun saveProviderKey(provider: String, key: String) = modelsWork { api.updateProviderApiKey(currentProfile(), provider, key.trim()) }

    /** One Models-tab mutation: saves, reports, and reloads the catalog so the tab shows the saved state. */
    private fun modelsWork(block: suspend () -> Unit) {
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { block() } }
                .onSuccess {
                    _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
                    loadModelProviders()
                }
                .onFailure { failure -> _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) } }
        }
    }

    fun setDefaultModelFromCatalog(provider: String, model: String) = modelsWork {
        api.setDefaultModel(currentProfile(), model, provider)
        _state.update { it.copy(defaultModel = model) }
    }
    fun setModelAlias(provider: String, model: String, alias: String) = modelsWork { api.updateModelAlias(currentProfile(), provider, model, alias.trim()) }
    fun setModelVisible(provider: ModelProvider, model: String, visible: Boolean) = modelsWork {
        val next = provider.models.filter { if (it.id == model) visible else it.visible }.map { it.id }
        api.updateModelVisibility(currentProfile(), provider.id, if (next.size == provider.models.size) null else next)
    }
    fun showAllProviderModels(provider: ModelProvider) = modelsWork { api.updateModelVisibility(currentProfile(), provider.id, null) }
    fun addCustomModel(provider: String, model: String) = modelsWork { api.addCustomModel(currentProfile(), provider, model.trim()) }
    fun removeCustomModel(provider: String, model: String) = modelsWork { api.removeCustomModel(currentProfile(), provider, model) }
    fun setModelContextLimit(provider: String, model: String, limit: Long) = modelsWork { api.updateModelContext(currentProfile(), provider, model, limit) }
    fun addCustomProvider(name: String, baseUrl: String, apiKey: String, apiMode: String) = modelsWork { api.addCustomProvider(currentProfile(), name.trim(), baseUrl.trim(), apiKey.trim(), apiMode) }
    fun removeProvider(provider: ModelProvider) = modelsWork { api.removeProvider(currentProfile(), provider) }
    fun restoreProviderModels(provider: String) = modelsWork { api.restoreProviderModels(currentProfile(), provider) }

    /** Settings › Display › Text size, applied to every screen through the theme. */
    fun setTextScale(scale: Float) {
        store.textScale = scale
        _state.update { it.copy(textScale = store.textScale) }
    }

    private fun loadAgentSettings() {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { api.agentSettings(profile) to api.autoStartPolicy() }
            }.onSuccess { (agent, policy) ->
                _state.update {
                    it.copy(agentSettings = agent, autoStart = policy, loadingAgentSettings = false)
                }
            }.onFailure { failure ->
                _state.update {
                    it.copy(loadingAgentSettings = false, error = failure.readableMessage(localized))
                }
            }
        }
    }

    /** Writes one agent knob; the server keeps the rest of the section as it is. */
    fun setAgentValue(key: String, value: Any) {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    api.updateConfigSection(profile, "agent", org.json.JSONObject().put(key, value))
                }
            }.onSuccess {
                _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
                loadAgentSettings()
            }.onFailure { failure ->
                _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
            }
        }
    }

    fun setAutoStart(policy: AutoStartPolicy) {
        val previous = _state.value.autoStart
        _state.update { it.copy(autoStart = policy, savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.setAutoStartPolicy(policy) } }
                .onSuccess {
                    _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
                    loadAgentSettings()
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(savingSetting = false, autoStart = previous, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    // ── scheduled jobs ──────────────────────────────────────────────────

    fun openCronJobs() {
        _state.update {
            it.copy(
                screen = Screen.CronJobs,
                toolReturnScreen = when (it.screen) {
                    Screen.AgentHub -> Screen.AgentHub
                    Screen.SettingsPage -> Screen.SettingsPage
                    else -> Screen.Settings
                },
                error = null,
                notice = null,
                editingCronJob = null,
                cronEditorJobId = null,
                openCronRun = null,
            )
        }
        refreshCronJobs()
    }

    fun refreshCronJobs() {
        if (_state.value.cronLoading) return
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(cronLoading = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.cronJobs(profile) } }
                .onSuccess { jobs ->
                    _state.update {
                        it.copy(cronJobs = jobs.sortedBy { job -> job.name.lowercase() }, cronLoading = false)
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(cronLoading = false, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    /** Opens a blank editor, or reloads one raw job before editing it. */
    fun openCronJob(jobId: String? = null) {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update {
            it.copy(
                screen = Screen.CronJob,
                editingCronJob = null,
                cronEditorJobId = jobId,
                cronEditorLoading = true,
                error = null,
                notice = null,
            )
        }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    // These enrich the form, but a missing optional endpoint
                    // must not make the core job impossible to edit. The failure
                    // is still shown, so a broken endpoint is not mistaken for
                    // "no models / skills / targets".
                    val problems = mutableListOf<Throwable>()
                    CronEditorData(
                        job = jobId?.let { api.cronJob(profile, it) },
                        models = runCatching { api.availableModels(profile) }.onFailure(problems::add).getOrDefault(emptyList()),
                        skills = runCatching { api.cronSkills(profile) }.onFailure(problems::add).getOrDefault(emptyList()),
                        targets = runCatching { api.cronDeliveryTargets(profile) }.onFailure(problems::add).getOrDefault(emptyList()),
                        problem = problems.firstOrNull(),
                    )
                }
            }.onSuccess { data ->
                _state.update {
                    it.copy(
                        editingCronJob = data.job,
                        models = data.models,
                        modelsProfile = profile,
                        cronSkills = data.skills,
                        cronDeliveryTargets = data.targets,
                        cronEditorLoading = false,
                        error = data.problem?.readableMessage(localized),
                    )
                }
            }.onFailure { failure ->
                _state.update {
                    it.copy(cronEditorLoading = false, error = failure.readableMessage(localized))
                }
            }
        }
    }

    fun saveCronJob(draft: CronJobDraft) {
        if (_state.value.savingSetting) return
        if (draft.name.isBlank()) {
            _state.update { it.copy(error = str(R.string.cron_name_required)) }
            return
        }
        if (draft.schedule.isBlank()) {
            _state.update { it.copy(error = str(R.string.cron_schedule_required)) }
            return
        }
        if (draft.prompt.isBlank()) {
            _state.update { it.copy(error = str(R.string.cron_prompt_required)) }
            return
        }
        if (draft.repeatTimes != null && draft.repeatTimes < 1) {
            _state.update { it.copy(error = str(R.string.cron_repeat_invalid)) }
            return
        }

        val profile = _state.value.activeProfile.ifBlank { "default" }
        val original = _state.value.editingCronJob
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    if (original == null) api.createCronJob(profile, draft)
                    else api.updateCronJob(profile, original, draft)
                }
            }.onSuccess { saved ->
                _state.update {
                    it.copy(
                        screen = Screen.CronJobs,
                        savingSetting = false,
                        editingCronJob = null,
                        cronEditorJobId = null,
                        cronJobs = it.cronJobs.upsert(saved),
                        notice = str(
                            if (original == null) R.string.cron_notice_created else R.string.cron_notice_updated,
                        ),
                    )
                }
            }.onFailure { failure ->
                _state.update {
                    it.copy(savingSetting = false, error = failure.readableMessage(localized))
                }
            }
        }
    }

    fun toggleCronJob(job: CronJob) {
        if (_state.value.cronActionId != null) return
        val profile = _state.value.activeProfile.ifBlank { "default" }
        val resume = job.state == "paused" || !job.enabled
        _state.update { it.copy(cronActionId = job.id, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    if (resume) api.resumeCronJob(profile, job.id) else api.pauseCronJob(profile, job.id)
                }
            }.onSuccess { updated ->
                _state.update {
                    it.copy(
                        cronActionId = null,
                        cronJobs = it.cronJobs.upsert(updated),
                        notice = str(if (resume) R.string.cron_notice_resumed else R.string.cron_notice_paused),
                    )
                }
            }.onFailure { failure ->
                _state.update {
                    it.copy(cronActionId = null, error = failure.readableMessage(localized))
                }
            }
        }
    }

    fun runCronJob(job: CronJob) {
        if (_state.value.cronActionId != null) return
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(cronActionId = job.id, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.runCronJob(profile, job.id) } }
                .onSuccess { updated ->
                    _state.update {
                        it.copy(
                            cronActionId = null,
                            cronJobs = it.cronJobs.upsert(updated),
                            notice = str(R.string.cron_notice_triggered),
                        )
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(cronActionId = null, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun deleteCronJob(job: CronJob) {
        if (_state.value.cronActionId != null) return
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(cronActionId = job.id, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.deleteCronJob(profile, job.id) } }
                .onSuccess {
                    _state.update {
                        it.copy(
                            cronActionId = null,
                            cronJobs = it.cronJobs.filterNot { candidate -> candidate.id == job.id },
                            notice = str(R.string.cron_notice_deleted),
                        )
                    }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(cronActionId = null, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun openCronHistory(job: CronJob) {
        _state.update {
            it.copy(
                screen = Screen.CronHistory,
                cronHistoryJob = job,
                cronRuns = emptyList(),
                openCronRun = null,
                error = null,
                notice = null,
            )
        }
        refreshCronHistory()
    }

    fun refreshCronHistory() {
        val job = _state.value.cronHistoryJob ?: return
        if (_state.value.cronHistoryLoading) return
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(cronHistoryLoading = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.cronRuns(profile, job.id) } }
                .onSuccess { runs ->
                    _state.update { it.copy(cronRuns = runs, cronHistoryLoading = false) }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(cronHistoryLoading = false, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun openCronRun(run: CronRun) {
        if (_state.value.cronRunLoading) return
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(cronRunLoading = true, openCronRun = null, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.cronRun(profile, run) } }
                .onSuccess { detail ->
                    _state.update { it.copy(cronRunLoading = false, openCronRun = detail) }
                }
                .onFailure { failure ->
                    _state.update {
                        it.copy(cronRunLoading = false, error = failure.readableMessage(localized))
                    }
                }
        }
    }

    fun dismissCronRun() = _state.update { it.copy(openCronRun = null) }

    // ── channels ──────────────────────────────────────────────────────────

    fun openChannels() {
        _state.update {
            it.copy(
                screen = Screen.Channels,
                toolReturnScreen = when (it.screen) {
                    Screen.AgentHub -> Screen.AgentHub
                    Screen.SettingsPage -> Screen.SettingsPage
                    else -> Screen.Settings
                },
                error = null,
                notice = null,
            )
        }
        refreshServerConfig()
    }

    /** Settings itself only needs the channel counts and the default model. */
    fun openSettings() {
        _state.update { it.copy(screen = Screen.Settings, error = null, notice = null, openGroup = null) }
        refreshServerConfig()
    }

    fun openProfiles() {
        _state.update { state ->
            val parent = when (state.screen) {
                Screen.Chats, Screen.Conversation, Screen.Groups, Screen.Workflows, Screen.History, Screen.AgentHub,
                Screen.Settings, Screen.SettingsGroup, Screen.SettingsPage,
                -> state.screen
                else -> state.tab.rootScreen(state.openSession)
            }
            state.copy(
                screen = Screen.Profiles,
                profilesReturnScreen = parent,
                error = null,
                notice = null,
            )
        }
    }

    fun openChannel(platform: String) {
        _state.update {
            it.copy(
                screen = Screen.Channel,
                openChannel = platform,
                weixinQr = if (platform == "weixin") it.weixinQr else WeixinQrUi(),
                error = null,
                notice = null,
            )
        }
    }

    /** Completes Weixin's Studio QR flow without leaving the native editor. */
    fun startWeixinQr() {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        weixinQrJob?.cancel()
        _state.update { it.copy(weixinQr = WeixinQrUi(status = "loading"), error = null, notice = null) }
        weixinQrJob = viewModelScope.launch {
            val code = runCatching { withContext(Dispatchers.IO) { api.weixinQrCode(profile) } }
                .getOrElse { failure ->
                    _state.update {
                        it.copy(weixinQr = WeixinQrUi(status = "error"), error = failure.readableMessage(localized))
                    }
                    return@launch
                }
            _state.update {
                it.copy(weixinQr = WeixinQrUi(status = "waiting", id = code.id, url = code.url))
            }

            repeat(100) {
                delay(3_000)
                val poll = runCatching {
                    withContext(Dispatchers.IO) { api.weixinQrStatus(profile, code.id) }
                }.getOrElse { failure ->
                    // Keep polling: one failed poll is not a failed login, but say so.
                    _state.update { it.copy(error = failure.readableMessage(localized)) }
                    return@repeat
                }
                when (poll.status) {
                    "confirmed" -> {
                        runCatching {
                            withContext(Dispatchers.IO) { api.saveWeixinCredentials(profile, poll) }
                        }.onSuccess {
                            _state.update {
                                it.copy(
                                    weixinQr = WeixinQrUi(status = "confirmed", id = code.id),
                                    notice = str(R.string.notice_weixin_linked),
                                )
                            }
                            refreshServerConfig()
                        }.onFailure { failure ->
                            _state.update {
                                it.copy(
                                    weixinQr = WeixinQrUi(status = "error", id = code.id),
                                    error = failure.readableMessage(localized),
                                )
                            }
                        }
                        return@launch
                    }
                    "expired" -> {
                        _state.update { it.copy(weixinQr = WeixinQrUi(status = "expired", id = code.id)) }
                        return@launch
                    }
                    "scaned", "scaned_but_redirect" -> _state.update {
                        it.copy(weixinQr = it.weixinQr.copy(status = "scanned"))
                    }
                    else -> Unit
                }
            }
            _state.update { it.copy(weixinQr = WeixinQrUi(status = "expired", id = code.id)) }
        }
    }

    private fun refreshServerConfig() {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.serverConfig(profile) } }
                .onSuccess { config ->
                    _state.update { it.copy(serverConfig = config, defaultModel = config.defaultModel) }
                }
                .onFailure { failure -> _state.update { it.copy(error = failure.readableMessage(localized)) } }
        }
    }

    /**
     * Writes a channel's credentials. The server restarts the gateway itself
     * once they land, which is what actually puts the channel online.
     */
    fun saveChannel(platform: String, values: Map<String, String>, enabled: Boolean) {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        val spec = channelSpec(platform)
        val label = spec.label
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val credentials = linkedMapOf<String, Any?>()
                    val configuration = org.json.JSONObject()

                    fun putNested(target: org.json.JSONObject, path: String, value: Any?) {
                        val parts = path.split('.')
                        var current = target
                        parts.dropLast(1).forEach { part ->
                            current = current.optJSONObject(part)
                                ?: org.json.JSONObject().also { current.put(part, it) }
                        }
                        current.put(parts.last(), value ?: org.json.JSONObject.NULL)
                    }

                    spec.fields.forEach { field ->
                        val raw = values[field.path].orEmpty()
                        val value: Any = when (field.kind) {
                            ChannelFieldKind.Toggle -> raw.toBooleanStrictOrNull() ?: field.defaultEnabled
                            ChannelFieldKind.CommaList -> org.json.JSONArray().apply {
                                raw.split(',').map(String::trim).filter(String::isNotEmpty).forEach(::put)
                            }
                            ChannelFieldKind.Text, ChannelFieldKind.Secret -> raw.trim()
                        }
                        if (field.target == ChannelFieldTarget.Credentials) credentials[field.path] = value
                        else putNested(configuration, field.path, value)
                    }

                    // WhatsApp owns its enablement through WHATSAPP_ENABLED.
                    // Other adapters retain the convenient app-level switch.
                    if (spec.fields.none {
                            it.target == ChannelFieldTarget.Credentials && it.path == "enabled"
                        }
                    ) {
                        configuration.put("enabled", enabled)
                    }

                    if (configuration.length() > 0) {
                        api.updateConfigSection(
                            profile,
                            platform,
                            configuration,
                            restart = credentials.isEmpty(),
                        )
                    }
                    if (credentials.isNotEmpty()) {
                        // Empty strings are intentional: Studio uses them to clear
                        // one incorrect value without deleting every credential.
                        api.updateChannelCredentials(profile, platform, credentials)
                    }
                }
            }.onSuccess {
                _state.update {
                    it.copy(savingSetting = false, notice = str(R.string.notice_channel_saved, label))
                }
                refreshServerConfig()
            }.onFailure { failure ->
                _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
            }
        }
    }

    fun clearChannel(platform: String) {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        val label = channelSpec(platform).label
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.clearChannelCredentials(profile, platform) } }
                .onSuccess {
                    _state.update {
                        it.copy(savingSetting = false, notice = str(R.string.notice_channel_cleared, label))
                    }
                    refreshServerConfig()
                }
                .onFailure { failure ->
                    _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
                }
        }
    }

    /** Whether the gateway comes up with the server, written server-side. */
    fun setGatewayAutoStart(enabled: Boolean) {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        val previous = _state.value.serverConfig
        _state.update { it.copy(serverConfig = previous?.copy(gatewayAutoStart = enabled), savingSetting = true) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    api.updateConfigSection(
                        profile,
                        "gatewayAutoStart",
                        org.json.JSONObject().put("enabled", enabled),
                    )
                }
            }.onSuccess {
                _state.update { it.copy(savingSetting = false, notice = str(R.string.notice_saved)) }
            }.onFailure { failure ->
                _state.update {
                    it.copy(savingSetting = false, serverConfig = previous, error = failure.readableMessage(localized))
                }
            }
        }
    }

    /** Writes the profile default, which is what new conversations start from. */
    fun setDefaultModel(option: ModelOption) {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { api.setDefaultModel(profile, option.id, option.provider) }
            }.onSuccess {
                _state.update {
                    it.copy(
                        savingSetting = false,
                        defaultModel = option.id,
                        notice = str(R.string.notice_default_model, profile, option.id),
                    )
                }
            }.onFailure { failure ->
                _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
            }
        }
    }

    fun restartGateway() {
        val profile = _state.value.activeProfile.ifBlank { "default" }
        _state.update { it.copy(savingSetting = true, error = null, notice = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { api.restartGateway(profile) } }
                .onSuccess {
                    _state.update {
                        it.copy(savingSetting = false, notice = str(R.string.notice_gateway_restarting, profile))
                    }
                }
                .onFailure { failure ->
                    _state.update { it.copy(savingSetting = false, error = failure.readableMessage(localized)) }
                }
        }
    }

    /** Replaces the app mark with a picture from the device. */
    fun setAppLogo(bytes: ByteArray) {
        viewModelScope.launch {
            val applied = AppLogo.setCustom(getApplication<Application>(), bytes)
            _state.update {
                if (applied) it.copy(notice = str(R.string.notice_logo_updated), error = null)
                else it.copy(error = str(R.string.error_image_unreadable))
            }
        }
    }

    /** Goes back to whatever logo the connected Studio serves. */
    fun resetAppLogo() {
        viewModelScope.launch {
            AppLogo.clearCustom(getApplication<Application>())
            runCatching { AppLogo.syncFromServer(getApplication<Application>(), api, force = true) }
            _state.update {
                if (AppLogo.image != null) {
                    it.copy(notice = str(R.string.notice_logo_from_server), error = null)
                } else {
                    it.copy(error = str(R.string.error_no_server_logo))
                }
            }
        }
    }

    fun dismissNotice() = _state.update { it.copy(notice = null) }

    /** A short confirmation from the UI (copied, shared, …) through the same notice strip. */
    fun showNotice(id: Int) = _state.update { it.copy(notice = str(id)) }

    // ── misc ──────────────────────────────────────────────────────────────

    fun back() {
        when (_state.value.screen) {
            // Leaving a conversation only detaches this phone. The explicit
            // stop button is the action that aborts an agent run on Studio.
            Screen.Conversation -> cancelActiveRun(abort = false)
            Screen.Room -> leaveRoom()
            Screen.Workflows -> stopListeningToWorkflows()
            else -> Unit
        }
        _state.update { state ->
            val visitedTarget = generateSequence { navigationHistory.removeLastOrNull() }
                .firstOrNull { it != state.screen && !it.isTransientDestination() }
            val target = visitedTarget ?: when (state.screen) {
                Screen.Channel -> Screen.Channels
                Screen.CronJob, Screen.CronHistory -> Screen.CronJobs
                Screen.KanbanTask -> Screen.Kanban
                Screen.Skill -> Screen.Skills
                Screen.Workflow -> Screen.Workflows
                Screen.WorkflowRun -> Screen.Workflow
                Screen.Kanban, Screen.Skills, Screen.Plugins, Screen.Mcp, Screen.AgentRuntimes, Screen.GlobalAgent, Screen.EkkoHub, Screen.Files, Screen.Connections, Screen.Webhooks, Screen.RuntimeVersions -> Screen.AgentHub
                Screen.Pets, Screen.Insights, Screen.Logs, Screen.Journey, Screen.Appearance, Screen.SettingsPage -> Screen.Settings
                Screen.Channels, Screen.SettingsGroup, Screen.CronJobs -> state.toolReturnScreen
                Screen.Profiles -> state.profilesReturnScreen
                else -> state.tab.rootScreen(state.openSession.takeUnless { state.screen == Screen.Conversation })
            }
            consumingBackNavigation = true
            state.copy(
                screen = target,
                error = null,
                openSession = state.openSession.takeUnless { state.screen == Screen.Conversation },
                lines = if (state.screen == Screen.Conversation) emptyList() else state.lines,
                openRoom = state.openRoom.takeUnless { state.screen == Screen.Room },
                attachments = if (state.screen == Screen.Conversation) emptyList() else state.attachments,
                sessionModel = state.sessionModel.takeUnless { state.screen == Screen.Conversation },
                sessionProvider = state.sessionProvider.takeUnless { state.screen == Screen.Conversation },
                editingCronJob = state.editingCronJob.takeUnless { state.screen == Screen.CronJob },
                cronEditorJobId = state.cronEditorJobId.takeUnless { state.screen == Screen.CronJob },
                openCronRun = null,
                openWorkflowRun = state.openWorkflowRun.takeUnless { state.screen == Screen.WorkflowRun },
                openWorkflow = state.openWorkflow.takeUnless { state.screen == Screen.Workflow },
                kanban = state.kanban.copy(
                    openTask = state.kanban.openTask.takeUnless { state.screen == Screen.KanbanTask },
                ),
                skillsUi = state.skillsUi.copy(
                    openSkill = state.skillsUi.openSkill.takeUnless { state.screen == Screen.Skill },
                ),
            )
        }
    }

    fun show(screen: Screen) = _state.update { it.copy(screen = screen, error = null) }

    fun dismissError() = _state.update { it.copy(error = null) }

    /** Lets device pickers surface a readable error without leaking UI concerns into them. */
    fun showToolError(failure: Throwable) = _state.update {
        it.copy(error = failure.readableMessage(localized))
    }

    fun signOut() {
        cancelActiveRun(abort = true)
        leaveRoom()
        stopListeningToWorkflows()
        store.clearCredentials()
        _state.update {
            UiState(
                screen = Screen.Login,
                baseUrl = store.baseUrl,
                reasoningEffort = store.reasoningEffort,
                language = store.language,
                appearance = store.appearance,
                voiceInput = store.voiceInput,
            )
        }
    }

    /** Chooses the language for every screen; the activity restarts to apply it. */
    fun setLanguage(tag: String) {
        store.language = tag
        _state.update { it.copy(language = tag) }
    }

    fun setAppearance(value: String) {
        store.appearance = value
        _state.update { it.copy(appearance = value) }
    }

    private fun str(id: Int, vararg args: Any): String = localized.getString(id, *args)

    private fun currentProfile(): String =
        _state.value.openSession?.profile?.ifBlank { null }
            ?: _state.value.activeProfile.ifBlank { "default" }

    private fun uniqueQueuedDownloadName(requested: String): String {
        val clean = inferDownloadFileName(requested, requested)
        if (queuedDownloadNames.add(clean)) return clean
        val dot = clean.lastIndexOf('.').takeIf { it > 0 }
        val stem = dot?.let(clean::substring) ?: clean
        val extension = dot?.let { clean.substring(it) }.orEmpty()
        var suffix = System.currentTimeMillis()
        while (true) {
            val candidate = "$stem-$suffix$extension"
            if (queuedDownloadNames.add(candidate)) return candidate
            suffix += 1
        }
    }

    private fun pickProfile(profiles: List<Profile>): String {
        val stored = store.profile
        if (stored.isNotBlank() && profiles.any { it.name == stored }) return stored
        val chosen = profiles.firstOrNull { it.active }?.name
            ?: profiles.firstOrNull()?.name
            ?: "default"
        store.profile = chosen
        return chosen
    }

    private fun <T> launchWork(
        work: suspend () -> T,
        onSuccess: (T) -> Unit,
        onFailure: ((Throwable) -> Unit)? = null,
    ) {
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { work() } }
                .onSuccess {
                    _state.update { state -> state.copy(busy = false, connected = true) }
                    onSuccess(it)
                }
                .onFailure { failure ->
                    // Only a transport failure means "disconnected"; an HTTP
                    // error proves the server answered.
                    _state.update { state -> state.copy(busy = false, connected = failure !is java.io.IOException) }
                    if (onFailure != null) onFailure(failure)
                    else _state.update { state -> state.copy(error = failure.readableMessage(localized)) }
                }
        }
    }

    private fun normalizeUrl(raw: String): String? {
        val trimmed = raw.trim().trimEnd('/')
        if (trimmed.isBlank()) return null
        val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            trimmed
        } else {
            "https://$trimmed"
        }
        return runCatching { java.net.URL(withScheme) }.map { withScheme }.getOrNull()
    }
}

private val STUDIO_CONFIG_GROUPS = setOf(
    SettingsGroup.Display,
    SettingsGroup.Proxy,
    SettingsGroup.Memory,
    SettingsGroup.Compression,
    SettingsGroup.Sessions,
    SettingsGroup.Privacy,
)

private data class CronEditorData(
    val job: CronJob?,
    val models: List<ModelOption>,
    val skills: List<String>,
    val targets: List<CronDeliveryTarget>,
    /** The first optional lookup that failed, shown next to the form. */
    val problem: Throwable? = null,
)

private fun List<CronJob>.upsert(job: CronJob): List<CronJob> =
    (filterNot { it.id == job.id } + job).sortedBy { it.name.lowercase() }

private val INVITE_ALPHABET = ('A'..'Z') + ('2'..'9')

/** Messages per page of the paginated transcript (the web uses 150 on the History page). */
internal const val HISTORY_PAGE = 60

internal fun Throwable.invalidatesSavedSession(): Boolean =
    (this as? HermesException)?.statusCode in setOf(401, 403)

/**
 * A session-scoped endpoint answered 404: the conversation was never created
 * on the server, or it has been deleted there. The stored id has to go, and
 * the screen shows the neutral empty state rather than the server's wording.
 */
internal fun Throwable.isMissingSession(): Boolean {
    val failure = this as? HermesException ?: return false
    return failure.statusCode == 404 || isSessionGoneError(failure.message)
}

/**
 * The session a turn belongs to: the open conversation first, the per-profile
 * stored id only when nothing is open. Reading the store first meant a stale
 * id — one the server had deleted — outranked the conversation the user was
 * actually looking at.
 */
internal fun chatSessionIdFor(openSessionId: String?, storedSessionId: String): String? =
    openSessionId?.takeIf { it.isNotBlank() } ?: storedSessionId.takeIf { it.isNotBlank() }

/**
 * Adds an error row unless the transcript already carries that exact message.
 * A reconnect loop used to stack one identical red row per attempt; the
 * banner already says it once.
 */
internal fun withErrorLine(lines: List<ChatLine>, text: String): List<ChatLine> {
    val message = text.trim()
    if (message.isEmpty()) return lines
    if (lines.any { it.isError && it.text == message }) return lines
    return lines + ChatLine(message, fromUser = false, isError = true)
}

/** Strips Markdown scaffolding and file links so a voice does not read "asterisk asterisk". */
internal fun plainSpeechText(markdown: String): String = parseChatMessage(markdown).text
    .replace(Regex("```[\\s\\S]*?```"), " ")
    .replace(Regex("`([^`]*)`"), "$1")
    .replace(Regex("!\\[[^\\]]*]\\([^)]*\\)"), " ")
    .replace(Regex("\\[([^\\]]*)]\\([^)]*\\)"), "$1")
    .replace(Regex("(?m)^\\s{0,3}#{1,6}\\s+"), "")
    .replace(Regex("(?m)^\\s*[-*+]\\s+"), "")
    .replace(Regex("(?m)^\\s*>\\s?"), "")
    .replace(Regex("[*_~]{1,3}"), "")
    .replace(Regex("[ \\t]+"), " ")
    .trim()

private fun Throwable.readableMessage(context: android.content.Context): String = when (this) {
    // A HermesException already carries what the server said, in its own words.
    is HermesException -> message ?: context.getString(R.string.error_request_failed)
    is java.net.UnknownHostException -> context.getString(R.string.error_unreachable)
    is java.net.SocketTimeoutException -> context.getString(R.string.error_timeout)
    is javax.net.ssl.SSLException -> context.getString(R.string.error_tls)
    else -> message ?: this::class.java.simpleName
}
