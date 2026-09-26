package hub.core.android.phone

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import hub.core.android.R
import hub.core.android.data.HubApis
import hub.core.android.data.StoredSession
import hub.core.android.data.hubCall
import hub.core.android.generated.FontTokens
import hub.core.android.graph
import hub.core.android.realtime.DEVICES_NAMESPACE
import hub.core.android.realtime.Envelope
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubDialog
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.infrastructure.Serializer
import hub.core.client.model.CapabilityKind
import hub.core.client.model.DeviceCapability
import hub.core.client.model.DeviceRequest
import hub.core.client.model.DeviceRequestError
import hub.core.client.model.DeviceRequestResponse
import hub.core.client.model.DeviceRequestStatus
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import kotlin.coroutines.resume
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/** What the person answered once for agents asking where this phone is (contract decision §105). */
enum class LocationChoice { ASK, ALWAYS, NEVER }

/** The rules of answering a location request, apart from Android so they are tested. */
object Locating {
    /** What to do with a request: ask the person, answer it, or say no at once. */
    enum class Next { ASK, ANSWER, DENY, IGNORE }

    fun next(request: DeviceRequest, choice: LocationChoice, now: OffsetDateTime = OffsetDateTime.now()): Next = when {
        request.capability != CapabilityKind.LOCATION || request.status != DeviceRequestStatus.PENDING -> Next.IGNORE
        request.expiresAt.isBefore(now) -> Next.IGNORE
        choice == LocationChoice.NEVER -> Next.DENY
        choice == LocationChoice.ALWAYS -> Next.ANSWER
        else -> Next.ASK
    }

    /** The one shape a location has (§14): latitude, longitude, accuracy in metres, when it was read. */
    fun result(latitude: Double, longitude: Double, accuracyM: Double, capturedAtMs: Long): Map<String, JsonElement> = mapOf(
        "latitude" to JsonPrimitive(latitude),
        "longitude" to JsonPrimitive(longitude),
        "accuracy_m" to JsonPrimitive(accuracyM.coerceAtLeast(0.0)),
        "captured_at" to JsonPrimitive(Instant.ofEpochMilli(capturedAtMs).atOffset(ZoneOffset.UTC).withNano(0).toString()),
    )

    fun fulfilled(result: Map<String, JsonElement>) = DeviceRequestResponse(status = DeviceRequestResponse.Status.FULFILLED, result = result)

    fun denied() = DeviceRequestResponse(
        status = DeviceRequestResponse.Status.DENIED,
        error = DeviceRequestError(code = DeviceRequestError.Code.PERMISSION_DENIED, message = "the person said no"),
    )

    fun failed(message: String) = DeviceRequestResponse(
        status = DeviceRequestResponse.Status.FAILED,
        error = DeviceRequestError(code = DeviceRequestError.Code.UNAVAILABLE, message = message),
    )

    /** What this phone tells the hub it can do: its location, off once the person said never. */
    fun capability(choice: LocationChoice) = DeviceCapability(kind = CapabilityKind.LOCATION, enabled = choice != LocationChoice.NEVER)

    /** A `request.created` envelope's request, when it is one. */
    fun requestOf(e: Envelope): DeviceRequest? {
        if (e.namespace != DEVICES_NAMESPACE || e.event != "request.created") return null
        val raw = e.payload["request"] ?: return null
        return runCatching { Serializer.kotlinxSerializationJson.decodeFromJsonElement(DeviceRequest.serializer(), raw) }.getOrNull()
    }
}

/** The person's answer, kept on the phone (This device changes it). */
class LocationChoices(private val prefs: SharedPreferences) {
    private val _choice = MutableStateFlow(
        runCatching { LocationChoice.valueOf(prefs.getString(KEY, null) ?: "") }.getOrDefault(LocationChoice.ASK),
    )
    val choice: StateFlow<LocationChoice> = _choice.asStateFlow()

    fun set(choice: LocationChoice) {
        prefs.edit().putString(KEY, choice.name).apply()
        _choice.value = choice
    }

    private companion object { const val KEY = "location_choice" }
}

/**
 * The location requests this phone has to answer: heard on `/rt/devices` (`request.created`,
 * sent to this device only) and caught up with `listRequests?status=pending` when the app comes
 * back. Those that need the person wait in [waiting] for the consent dialog.
 */
class LocationRequests(
    private val apis: () -> Pair<HubApis, StoredSession>?,
    private val choices: LocationChoices,
    private val locate: suspend () -> Map<String, JsonElement>?,
) {
    private val _waiting = MutableStateFlow<List<DeviceRequest>>(emptyList())
    val waiting: StateFlow<List<DeviceRequest>> = _waiting.asStateFlow()

    suspend fun heard(request: DeviceRequest) {
        when (Locating.next(request, choices.choice.value)) {
            Locating.Next.ASK -> _waiting.update { list -> if (list.any { it.id == request.id }) list else list + request }
            Locating.Next.ANSWER -> answer(request)
            Locating.Next.DENY -> respond(request, Locating.denied())
            Locating.Next.IGNORE -> Unit
        }
    }

    /** Pending requests for this phone the socket may have missed (the app was closed). */
    suspend fun catchUp() {
        val (api, session) = apis() ?: return
        val device = session.deviceId ?: return
        hubCall { api.devices.devicesListRequests(session.profile, deviceId = device, status = DeviceRequestStatus.PENDING, limit = 20).items }
            .onSuccess { list -> list.forEach { heard(it) } }
    }

    /** The person answered the dialog: yes (once or every time) reads the place; no says so. */
    suspend fun decide(request: DeviceRequest, allow: Boolean, remember: Boolean) {
        _waiting.update { list -> list.filterNot { it.id == request.id } }
        if (remember) choices.set(if (allow) LocationChoice.ALWAYS else LocationChoice.NEVER)
        if (allow) answer(request) else respond(request, Locating.denied())
    }

    private suspend fun answer(request: DeviceRequest) {
        val place = runCatching { locate() }.getOrNull()
        respond(request, place?.let(Locating::fulfilled) ?: Locating.failed("the phone could not read its location"))
    }

    private suspend fun respond(request: DeviceRequest, response: DeviceRequestResponse) {
        val (api, _) = apis() ?: return
        hubCall { api.devices.devicesRespondRequest(request.profile, request.id, response) }
    }
}

/** This phone's current place, from Android's own location service (no Play services needed). */
object PhoneLocation {
    fun allowed(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission") // checked by allowed()
    suspend fun read(context: Context): Map<String, JsonElement>? {
        if (!allowed(context)) return null
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        val provider = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).firstOrNull { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
        val fresh: Location? = if (provider != null && Build.VERSION.SDK_INT >= 30) {
            withTimeoutOrNull(20_000) {
                suspendCancellableCoroutine { cont ->
                    val cancel = CancellationSignal()
                    cont.invokeOnCancellation { cancel.cancel() }
                    manager.getCurrentLocation(provider, cancel, context.mainExecutor) { cont.resume(it) }
                }
            }
        } else null
        val location = fresh ?: listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
            .mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
            .maxByOrNull { it.time }
            ?: return null
        return Locating.result(location.latitude, location.longitude, location.accuracy.toDouble(), location.time)
    }
}

/**
 * The consent dialog, the first time an agent asks (and every time while the person keeps
 * «Only this time»): who asks and why, then Android's own location permission when needed.
 */
@Composable
fun LocationConsent() {
    val context = LocalContext.current
    val graph = context.graph
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val waiting by graph.locations.waiting.collectAsState()
    val request = waiting.firstOrNull() ?: return
    var pending by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf<Pair<Boolean, Boolean>?>(null) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val (allow, remember) = pending ?: return@rememberLauncherForActivityResult
        scope.launch { graph.locations.decide(request, allow && granted.values.any { it }, remember && granted.values.any { it }) }
    }
    fun go(allow: Boolean, remember: Boolean) {
        if (allow && !PhoneLocation.allowed(context)) {
            pending = allow to remember
            permission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
        } else {
            scope.launch { graph.locations.decide(request, allow, remember) }
        }
    }
    HubDialog({ go(allow = false, remember = false) }, stringResource(R.string.locate_title)) {
        Column(Modifier.fillMaxWidth().testTag("locate.dialog"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.locate_body), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
            request.purpose?.takeIf { it.isNotBlank() && it != "devices.locate" }?.let {
                Text(stringResource(R.string.locate_why, it), fontSize = FontTokens.sizeSm.sp)
            }
            HubButton(stringResource(R.string.locate_always), { go(allow = true, remember = true) }, icon = Lucide.MapPin, fill = true, size = ControlSize.Md, modifier = Modifier.fillMaxWidth().testTag("locate.always"))
            HubButton(stringResource(R.string.locate_once), { go(allow = true, remember = false) }, kind = ButtonKind.Secondary, fill = true, size = ControlSize.Md, modifier = Modifier.fillMaxWidth().testTag("locate.once"))
            HubButton(stringResource(R.string.locate_never), { go(allow = false, remember = true) }, kind = ButtonKind.Ghost, fill = true, size = ControlSize.Md, modifier = Modifier.fillMaxWidth().testTag("locate.never"))
        }
    }
}

