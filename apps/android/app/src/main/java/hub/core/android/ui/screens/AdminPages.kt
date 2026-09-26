package hub.core.android.ui.screens

import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import hub.core.android.R
import hub.core.android.data.HubApis
import hub.core.android.data.HubError
import hub.core.android.data.hubCall
import hub.core.android.generated.FontTokens
import hub.core.android.generated.RadiusTokens
import hub.core.android.graph
import hub.core.android.ui.components.ErrorNotice
import hub.core.android.ui.components.LoadView
import hub.core.android.ui.components.rememberLoad
import hub.core.android.ui.kit.Badge
import hub.core.android.ui.kit.BadgeTone
import hub.core.android.ui.kit.ButtonKind
import hub.core.android.ui.kit.ConfirmDialog
import hub.core.android.ui.kit.ControlSize
import hub.core.android.ui.kit.Custom
import hub.core.android.ui.kit.EmptyState
import hub.core.android.ui.kit.GroupedList
import hub.core.android.ui.kit.HubButton
import hub.core.android.ui.kit.HubCard
import hub.core.android.ui.kit.HubCheckbox
import hub.core.android.ui.kit.HubDialog
import hub.core.android.ui.kit.HubIconButton
import hub.core.android.ui.kit.HubMenu
import hub.core.android.ui.kit.HubSheet
import hub.core.android.ui.kit.HubSwitch
import hub.core.android.ui.kit.HubTextField
import hub.core.android.ui.kit.Item
import hub.core.android.ui.kit.Lucide
import hub.core.android.ui.kit.MenuItem
import hub.core.android.ui.kit.NoticeBox
import hub.core.android.ui.kit.SectionTitle
import hub.core.android.ui.kit.Segment
import hub.core.android.ui.kit.Segmented
import hub.core.android.ui.kit.StatusDot
import hub.core.android.ui.kit.ToggleRow
import hub.core.android.ui.theme.LocalTokens
import hub.core.client.api.AuditApi
import hub.core.client.model.Device
import hub.core.client.model.DevicePatch
import hub.core.client.model.NoticeKind
import hub.core.client.model.NotifyPreferences
import hub.core.client.model.NotifyPreferencesEventsValue
import hub.core.client.model.Pairing
import hub.core.client.model.PairingCreate
import hub.core.client.model.User
import hub.core.client.model.UserAdminPatch
import hub.core.client.model.UserCreate
import hub.core.client.model.UserStatus
import kotlinx.coroutines.launch

/** The admin pages' rules on the phone (Users, notification settings, devices, usage), apart from the screens. */
object AdminRules {
    private val USERNAME = Regex("^[a-z0-9._-]{2,40}$")

    /** The web's rule: two to forty lowercase letters, digits, and `. _ -`. */
    fun usernameOk(name: String): Boolean = USERNAME.matches(name.trim())

    fun passwordOk(password: String): Boolean = password.length >= 8

    /** A new person: a member needs at least one profile; an admin enters every profile. */
    fun create(username: String, displayName: String, password: String, admin: Boolean, profiles: List<String>): UserCreate? {
        if (!usernameOk(username) || !passwordOk(password)) return null
        if (!admin && profiles.isEmpty()) return null
        return UserCreate(
            username = username.trim(),
            password = password,
            role = if (admin) UserCreate.Role.ADMIN else UserCreate.Role.MEMBER,
            displayName = displayName.trim().ifEmpty { null },
            profiles = if (admin) null else profiles,
            defaultProfile = if (admin) null else profiles.first(),
        )
    }

    /** Every notice kind as a row of the table: a missing kind means both on (the contract's rule). */
    fun rows(prefs: NotifyPreferences): List<Pair<NoticeKind, NotifyPreferencesEventsValue>> =
        NoticeKind.entries.map { kind -> kind to (prefs.events[kind.value] ?: NotifyPreferencesEventsValue(inApp = true, push = true)) }

    fun set(prefs: NotifyPreferences, kind: NoticeKind, inApp: Boolean? = null, push: Boolean? = null): NotifyPreferences {
        val current = prefs.events[kind.value] ?: NotifyPreferencesEventsValue(inApp = true, push = true)
        val next = NotifyPreferencesEventsValue(inApp = inApp ?: current.inApp, push = push ?: current.push)
        return prefs.copy(events = prefs.events + (kind.value to next))
    }

    /** `HH:mm`, as the hub takes quiet hours. */
    fun timeOk(text: String): Boolean = Regex("^[0-2][0-9]:[0-5][0-9]$").matches(text) && text.substring(0, 2).toInt() < 24

    /** Devices by kind, this one first, then the most recently seen. */
    fun devices(list: List<Device>): List<Device> =
        list.sortedWith(compareByDescending<Device> { it.thisDevice }.thenByDescending { it.lastSeenAt ?: it.createdAt })

    /** A share of the total as a whole percent (for the usage bars). */
    fun percent(part: Long, total: Long): Int = if (total <= 0) 0 else ((part * 100 + total / 2) / total).toInt().coerceIn(0, 100)

    /** A token count people read at a glance: 950, 12.3K, 4.1M. */
    fun tokens(n: Long): String = when {
        n >= 1_000_000 -> String.format(java.util.Locale.ROOT, "%.1fM", n / 1_000_000.0)
        n >= 1_000 -> String.format(java.util.Locale.ROOT, "%.1fK", n / 1_000.0)
        else -> n.toString()
    }
}

/** What the admin pages change. */
class AdminOps(private val apis: () -> HubApis?, val profile: String) {
    private suspend fun <T> call(block: suspend (HubApis) -> T): Result<T> {
        val api = apis() ?: return Result.failure(HubError(401, "unauthorized", null))
        return hubCall { block(api) }
    }

    suspend fun users() = call { it.auth.authListUsers(limit = 200).items }
    suspend fun addUser(body: UserCreate) = call { it.auth.authCreateUser(body) }
    suspend fun updateUser(id: String, patch: UserAdminPatch) = call { it.auth.authUpdateUser(id, patch) }
    suspend fun deleteUser(id: String) = call { it.auth.authDeleteUser(id) }
    suspend fun profiles() = call { it.auth.authListProfiles().items }
    suspend fun preferences() = call { it.notify.notifyGetPreferences() }
    suspend fun savePreferences(p: NotifyPreferences) = call { it.notify.notifySetPreferences(p) }
    suspend fun devices() = call { it.devices.devicesList(limit = 200).items }
    suspend fun rename(d: Device, name: String) = call { it.devices.devicesUpdate(d.id, DevicePatch(name = name.trim())) }
    suspend fun testPush(d: Device) = call { it.devices.devicesTestPush(d.id) }
    suspend fun unlink(d: Device) = call { it.devices.devicesUnlink(d.id) }
    suspend fun pairing() = call { it.auth.authCreatePairing(PairingCreate()) }
    suspend fun usage(days: Int, all: Boolean) = call { it.audit.auditGetUsage(profile, days = days, profiles = if (all) AuditApi.ProfilesAuditGetUsage.ALL else null) }
}

@Composable
private fun rememberAdminOps(profile: String): AdminOps {
    val context = LocalContext.current
    return remember(profile) { AdminOps({ context.graph.store.current?.let(context.graph::apis) }, profile) }
}

private val pad = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp)

/** People: everyone on the hub, their role and state; add a person, make admin or member, disable, set a password, delete. */
@Composable
fun PeoplePage(profile: String, me: String) {
    val ops = rememberAdminOps(profile)
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val users = rememberLoad("people") { ops.users().getOrThrow() }
    var adding by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf<User?>(null) }
    var password by remember { mutableStateOf<User?>(null) }
    var error by remember { mutableStateOf<HubError?>(null) }
    fun act(r: Result<*>) { r.onFailure { error = it as HubError }.onSuccess { error = null }; users.reload() }
    LoadView(users) { list ->
        LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("people.list")) {
            item { ErrorNotice(error) }
            item { HubButton(stringResource(R.string.people_add), { adding = true }, icon = Lucide.UserPlus, kind = ButtonKind.Subtle, size = ControlSize.Md, modifier = Modifier.testTag("people.add")) }
            item {
                GroupedList {
                    list.forEach { u ->
                        Item(
                            u.displayName, subtitle = "@${u.username}", icon = Lucide.CircleUserRound, tag = "person.${u.username}",
                            trailing = {
                                if (u.status == UserStatus.DISABLED) Badge(stringResource(R.string.people_disabled), tone = BadgeTone.Warning)
                                Badge(stringResource(roleLabel(u.role.value)), tone = if (u.role.value == "member") BadgeTone.Neutral else BadgeTone.Accent)
                                if (u.role.value != "owner" && u.id != me) Box {
                                    HubIconButton(Lucide.Ellipsis, stringResource(R.string.chat_more), { menu = u.id }, size = 32.dp, iconSize = 16.dp, modifier = Modifier.testTag("person.${u.username}.more"))
                                    HubMenu(menu == u.id, { menu = null }) {
                                        val admin = u.role.value == "admin"
                                        MenuItem(stringResource(if (admin) R.string.people_make_member else R.string.people_make_admin), {
                                            menu = null
                                            scope.launch { act(ops.updateUser(u.id, UserAdminPatch(role = if (admin) UserAdminPatch.Role.MEMBER else UserAdminPatch.Role.ADMIN))) }
                                        }, icon = Lucide.ShieldCheck)
                                        MenuItem(stringResource(if (u.status == UserStatus.DISABLED) R.string.people_enable else R.string.people_disable), {
                                            menu = null
                                            scope.launch { act(ops.updateUser(u.id, UserAdminPatch(status = if (u.status == UserStatus.DISABLED) UserStatus.ACTIVE else UserStatus.DISABLED))) }
                                        }, icon = Lucide.Power)
                                        MenuItem(stringResource(R.string.people_set_password), { menu = null; password = u }, icon = Lucide.KeyRound)
                                        MenuItem(stringResource(R.string.presets_delete), { menu = null; deleting = u }, icon = Lucide.Trash, danger = true)
                                    }
                                }
                            },
                        )
                    }
                }
            }
            item { Text(stringResource(R.string.people_owner_note), fontSize = FontTokens.sizeXs.sp, color = t.textMuted) }
        }
    }
    if (adding) AddPersonSheet(ops, onDone = { adding = false; users.reload() })
    password?.let { u ->
        var typed by remember(u.id) { mutableStateOf("") }
        HubDialog({ password = null }, stringResource(R.string.people_password_for, u.displayName)) {
            Text(stringResource(R.string.people_password_note), fontSize = FontTokens.sizeSm.sp, color = t.textMuted)
            HubTextField(typed, { typed = it }, visualTransformation = PasswordVisualTransformation(), error = if (typed.isNotEmpty() && !AdminRules.passwordOk(typed)) stringResource(R.string.people_password_short) else null, fieldTag = "person.password")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                HubButton(stringResource(R.string.cancel), { password = null }, kind = ButtonKind.Secondary, size = ControlSize.Md)
                HubButton(stringResource(R.string.save), { scope.launch { act(ops.updateUser(u.id, UserAdminPatch(password = typed))) }; password = null }, size = ControlSize.Md, enabled = AdminRules.passwordOk(typed))
            }
        }
    }
    deleting?.let { u ->
        ConfirmDialog(
            stringResource(R.string.people_delete_title, u.displayName), stringResource(R.string.people_delete_body), stringResource(R.string.presets_delete),
            onConfirm = { scope.launch { act(ops.deleteUser(u.id)) }; deleting = null }, onDismiss = { deleting = null }, danger = true,
        )
    }
}

private fun roleLabel(role: String): Int = when (role) {
    "owner" -> R.string.people_role_owner
    "admin" -> R.string.people_role_admin
    else -> R.string.people_role_member
}

@Composable
private fun AddPersonSheet(ops: AdminOps, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val profiles = rememberLoad("profiles") { ops.profiles().getOrThrow() }
    var username by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var admin by remember { mutableStateOf(false) }
    var chosen by remember { mutableStateOf(listOf<String>()) }
    var error by remember { mutableStateOf<HubError?>(null) }
    var busy by remember { mutableStateOf(false) }
    val body = AdminRules.create(username, name, password, admin, chosen)
    HubSheet(onDismiss = onDone, title = stringResource(R.string.people_add)) {
        ErrorNotice(error)
        HubTextField(username, { username = it.lowercase() }, label = stringResource(R.string.people_username), placeholder = stringResource(R.string.people_username_hint), mono = true, size = ControlSize.Md,
            error = if (username.isNotEmpty() && !AdminRules.usernameOk(username)) stringResource(R.string.people_username_bad) else null, fieldTag = "person.username")
        HubTextField(name, { name = it }, label = stringResource(R.string.people_display_name), size = ControlSize.Md, fieldTag = "person.name")
        HubTextField(password, { password = it }, label = stringResource(R.string.people_password), visualTransformation = PasswordVisualTransformation(), size = ControlSize.Md,
            error = if (password.isNotEmpty() && !AdminRules.passwordOk(password)) stringResource(R.string.people_password_short) else null, fieldTag = "person.new_password")
        Segmented(
            listOf(Segment(false, stringResource(R.string.people_role_member)), Segment(true, stringResource(R.string.people_role_admin))),
            admin, { admin = it }, Modifier.fillMaxWidth(), size = ControlSize.Sm,
        )
        Text(stringResource(if (admin) R.string.people_admin_can else R.string.people_member_can), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
        if (!admin) {
            LoadView(profiles) { list ->
                GroupedList(title = stringResource(R.string.people_profiles)) {
                    list.forEach { p ->
                        Item(p.name, tag = "person.profile.${p.slug}", onClick = { chosen = if (p.slug in chosen) chosen - p.slug else chosen + p.slug },
                            trailing = { HubCheckbox(p.slug in chosen, null) })
                    }
                }
            }
        }
        HubButton(stringResource(R.string.people_add), {
            val b = body ?: return@HubButton
            busy = true
            scope.launch { ops.addUser(b).onSuccess { onDone() }.onFailure { error = it as HubError }; busy = false }
        }, icon = Lucide.UserPlus, fill = true, loading = busy, enabled = body != null, modifier = Modifier.fillMaxWidth().testTag("person.create"))
    }
}

/** The notification settings table: each kind of notice, in the app and as a push; and quiet hours. */
@Composable
fun NotificationSettings(profile: String) {
    val ops = rememberAdminOps(profile)
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val load = rememberLoad("notify-prefs") { ops.preferences().getOrThrow() }
    var error by remember { mutableStateOf<HubError?>(null) }
    LoadView(load) { loaded ->
        var prefs by remember(loaded) { mutableStateOf(loaded) }
        fun save(next: NotifyPreferences) {
            prefs = next
            scope.launch { ops.savePreferences(next).onSuccess { prefs = it; error = null }.onFailure { error = it as HubError } }
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("notify.settings")) {
            ErrorNotice(error)
            GroupedList {
                Custom {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("", modifier = Modifier.weight(1f))
                        Text(stringResource(R.string.notify_in_app), fontSize = FontTokens.sizeXs.sp, color = t.textMuted, modifier = Modifier.padding(horizontal = 8.dp))
                        Text(stringResource(R.string.notify_push), fontSize = FontTokens.sizeXs.sp, color = t.textMuted, modifier = Modifier.padding(horizontal = 8.dp))
                    }
                }
                AdminRules.rows(prefs).forEach { (kind, v) ->
                    Custom(Modifier.testTag("notify.${kind.value}")) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(stringResource(noticeKindLabel(kind)), fontSize = FontTokens.sizeSm.sp, modifier = Modifier.weight(1f))
                            HubSwitch(v.inApp, { save(AdminRules.set(prefs, kind, inApp = it)) }, Modifier.testTag("notify.${kind.value}.in_app"))
                            HubSwitch(v.push, { save(AdminRules.set(prefs, kind, push = it)) }, Modifier.testTag("notify.${kind.value}.push"))
                        }
                    }
                }
            }
            GroupedList(title = stringResource(R.string.notify_quiet)) {
                Custom {
                    ToggleRow(stringResource(R.string.notify_quiet_on), prefs.quietHours.enabled, { save(prefs.copy(quietHours = prefs.quietHours.copy(enabled = it))) }, subtitle = stringResource(R.string.notify_quiet_hint))
                }
                if (prefs.quietHours.enabled) Custom {
                    var from by remember(prefs.quietHours.from) { mutableStateOf(prefs.quietHours.from) }
                    var to by remember(prefs.quietHours.to) { mutableStateOf(prefs.quietHours.to) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        HubTextField(from, { from = it; if (AdminRules.timeOk(it)) save(prefs.copy(quietHours = prefs.quietHours.copy(from = it))) }, label = stringResource(R.string.notify_from), mono = true, size = ControlSize.Sm, modifier = Modifier.weight(1f), fieldTag = "notify.from")
                        HubTextField(to, { to = it; if (AdminRules.timeOk(it)) save(prefs.copy(quietHours = prefs.quietHours.copy(to = it))) }, label = stringResource(R.string.notify_to), mono = true, size = ControlSize.Sm, modifier = Modifier.weight(1f), fieldTag = "notify.to")
                    }
                    Text(prefs.quietHours.timezone, fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                }
            }
        }
    }
}

fun noticeKindLabel(kind: NoticeKind): Int = when (kind) {
    NoticeKind.RUN_COMPLETED -> R.string.notify_kind_run_completed
    NoticeKind.APPROVAL_REQUESTED -> R.string.notify_kind_approval_requested
    NoticeKind.ROOM_MENTION -> R.string.notify_kind_room_mention
    NoticeKind.TASK_MOVED -> R.string.notify_kind_task_moved
    NoticeKind.SCHEDULE_FAILED -> R.string.notify_kind_schedule_failed
    NoticeKind.UPDATE_AVAILABLE -> R.string.notify_kind_update_available
    NoticeKind.SYSTEM -> R.string.notify_kind_system
}

/** A QR picture of a pairing code, for another phone to scan from this screen. */
private fun qr(text: String, size: Int = 480): Bitmap? = runCatching {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
    Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565).apply {
        for (x in 0 until size) for (y in 0 until size) setPixel(x, y, if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
    }
}.getOrNull()

/**
 * Device connections (the cards of #149): pairing another phone or computer at the top, then the
 * person's devices — this one first — with their state, last active and push; rename, test the
 * push, remove.
 */
@Composable
fun DevicesPage(profile: String) {
    val context = LocalContext.current
    val ops = rememberAdminOps(profile)
    val scope = rememberCoroutineScope()
    val t = LocalTokens.current
    val devices = rememberLoad("devices") { ops.devices().getOrThrow() }
    var pairing by remember { mutableStateOf<Pairing?>(null) }
    var error by remember { mutableStateOf<HubError?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf<Device?>(null) }
    var removing by remember { mutableStateOf<Device?>(null) }
    val pushSent = stringResource(R.string.devices_push_sent)
    LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("devices.page")) {
        item { ErrorNotice(error) }
        note?.let { item { NoticeBox(it, BadgeTone.Info) } }
        item {
            HubCard(padding = 14.dp) {
                Text(stringResource(R.string.devices_pair_title), fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold)
                Text(stringResource(R.string.devices_pair_hint), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                pairing?.let { p ->
                    val bitmap = remember(p.qrPayload) { qr(p.qrPayload) }
                    if (bitmap != null) {
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            Image(bitmap.asImageBitmap(), stringResource(R.string.devices_qr), Modifier.size(200.dp).background(Color.White, RoundedCornerShape(RadiusTokens.md.dp)).padding(8.dp))
                        }
                    }
                    Text(p.code, fontSize = FontTokens.sizeXl.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace, modifier = Modifier.fillMaxWidth().testTag("devices.code"))
                    Text(stringResource(R.string.devices_expires, localTime(p.expiresAt)), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        HubButton(stringResource(R.string.models_copy_code), {
                            (context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(ClipData.newPlainText("pairing", p.qrPayload))
                        }, kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.Copy)
                        HubButton(stringResource(R.string.devices_share_link), {
                            context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, p.qrPayload), null))
                        }, kind = ButtonKind.Secondary, size = ControlSize.Sm, icon = Lucide.Share2)
                    }
                }
                HubButton(
                    stringResource(if (pairing == null) R.string.devices_make_pairing else R.string.devices_new_pairing),
                    { scope.launch { ops.pairing().onSuccess { pairing = it; error = null }.onFailure { error = it as HubError } } },
                    size = ControlSize.Md, icon = Lucide.QrCode, modifier = Modifier.testTag("devices.pair"),
                )
            }
        }
        item {
            LoadView(devices) { list ->
                if (list.isEmpty()) EmptyState(stringResource(R.string.devices_none), icon = Lucide.Smartphone)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    AdminRules.devices(list).forEach { d ->
                        HubCard(Modifier.testTag("device.${d.id}"), padding = 14.dp) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                StatusDot(if (d.online) t.statusRunning else t.textFaint, stringResource(if (d.online) R.string.channel_online else R.string.channel_offline))
                                Column(Modifier.weight(1f)) {
                                    Text(d.name, fontSize = FontTokens.sizeMd.sp, fontWeight = FontWeight.SemiBold)
                                    Text(
                                        listOfNotNull(listOfNotNull(d.brand, d.model).joinToString(" ").ifEmpty { null }, d.osVersion, d.appVersion?.let { "v$it" }).joinToString(" · "),
                                        fontSize = FontTokens.sizeXs.sp, color = t.textMuted,
                                    )
                                }
                                if (d.thisDevice) Badge(stringResource(R.string.devices_this), tone = BadgeTone.Accent)
                                Box {
                                    HubIconButton(Lucide.Ellipsis, stringResource(R.string.chat_more), { menu = d.id }, size = 32.dp, iconSize = 16.dp, modifier = Modifier.testTag("device.${d.id}.more"))
                                    HubMenu(menu == d.id, { menu = null }) {
                                        MenuItem(stringResource(R.string.devices_rename), { menu = null; renaming = d }, icon = Lucide.Pencil)
                                        if (d.push != null) MenuItem(stringResource(R.string.devices_test_push), {
                                            menu = null
                                            scope.launch { ops.testPush(d).onSuccess { r -> note = r.error ?: pushSent }.onFailure { error = it as HubError } }
                                        }, icon = Lucide.Bell)
                                        if (!d.thisDevice) MenuItem(stringResource(R.string.devices_remove), { menu = null; removing = d }, icon = Lucide.Trash, danger = true)
                                    }
                                }
                            }
                            Text(
                                listOfNotNull(
                                    d.lastSeenAt?.let { stringResource(R.string.devices_last_seen, localTime(it)) },
                                    stringResource(if (d.push != null) R.string.devices_push_on else R.string.devices_push_off),
                                ).joinToString(" · "),
                                fontSize = FontTokens.sizeXs.sp, color = t.textMuted,
                            )
                        }
                    }
                }
            }
        }
    }
    renaming?.let { d ->
        var name by remember(d.id) { mutableStateOf(d.name) }
        HubDialog({ renaming = null }, stringResource(R.string.devices_rename)) {
            HubTextField(name, { name = it }, fieldTag = "device.name")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                HubButton(stringResource(R.string.cancel), { renaming = null }, kind = ButtonKind.Secondary, size = ControlSize.Md)
                HubButton(stringResource(R.string.save), { scope.launch { ops.rename(d, name).onFailure { error = it as HubError }; devices.reload() }; renaming = null }, size = ControlSize.Md, enabled = name.isNotBlank())
            }
        }
    }
    removing?.let { d ->
        ConfirmDialog(
            stringResource(R.string.devices_remove_confirm, d.name), stringResource(R.string.devices_remove_body), stringResource(R.string.devices_remove),
            onConfirm = { scope.launch { ops.unlink(d).onFailure { error = it as HubError }; devices.reload() }; removing = null }, onDismiss = { removing = null }, danger = true,
        )
    }
}

/** Usage at a glance: tokens, runs and cost over a week or a month, then by model and by agent. */
@Composable
fun UsagePage(profile: String, isAdmin: Boolean) {
    val ops = rememberAdminOps(profile)
    val t = LocalTokens.current
    var days by remember { mutableStateOf(30) }
    var all by remember { mutableStateOf(false) }
    val load = rememberLoad("usage", days, all) { ops.usage(days, all).getOrThrow() }
    LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("usage.page")) {
        item {
            Segmented(listOf(Segment(7, stringResource(R.string.usage_week)), Segment(30, stringResource(R.string.usage_month))), days, { days = it }, Modifier.fillMaxWidth(), size = ControlSize.Sm)
        }
        if (isAdmin) item {
            ToggleRow(stringResource(R.string.usage_all_profiles), all, { all = it })
        }
        item {
            LoadView(load) { r ->
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(
                            stringResource(R.string.usage_tokens) to AdminRules.tokens(r.totals.totalTokens.toLong()),
                            stringResource(R.string.usage_runs) to r.totals.runs.toString(),
                            stringResource(R.string.usage_cost) to (r.totals.cost?.let { "$" + it.amount } ?: "—"),
                        ).forEach { (label, value) ->
                            HubCard(Modifier.weight(1f).testTag("usage.total.$label"), padding = 12.dp) {
                                Text(value, fontSize = FontTokens.sizeLg.sp, fontWeight = FontWeight.SemiBold)
                                Text(label, fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                            }
                        }
                    }
                    if (r.totals.unreportedRuns > 0) Text(stringResource(R.string.usage_unreported, r.totals.unreportedRuns), fontSize = FontTokens.sizeXs.sp, color = t.textMuted)
                    if (r.byModel.isNotEmpty()) GroupedList(title = stringResource(R.string.usage_by_model)) {
                        r.byModel.take(8).forEach { m ->
                            Item(m.model, subtitle = stringResource(R.string.usage_row, AdminRules.tokens(m.totalTokens.toLong()), m.runs), value = "${AdminRules.percent(m.totalTokens.toLong(), r.totals.totalTokens.toLong())}%")
                        }
                    }
                    if (r.byAgent.isNotEmpty()) GroupedList(title = stringResource(R.string.usage_by_agent)) {
                        r.byAgent.take(8).forEach { a ->
                            Item(a.name ?: a.agentId, subtitle = stringResource(R.string.usage_row, AdminRules.tokens((a.totalTokens ?: 0).toLong()), a.runs), value = a.cost?.let { "$" + it.amount })
                        }
                    }
                    if (r.byModel.isEmpty() && r.byAgent.isEmpty()) EmptyState(stringResource(R.string.usage_none), icon = Lucide.ChartColumn)
                }
            }
        }
    }
}
