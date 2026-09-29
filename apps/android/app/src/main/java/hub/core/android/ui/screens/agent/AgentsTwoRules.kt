package hub.core.android.ui.screens

import hub.core.client.model.Channel
import hub.core.client.model.ChannelField
import hub.core.client.model.ChannelLink
import hub.core.client.model.ChannelPlatform
import hub.core.client.model.ChannelSetting
import hub.core.client.model.ChannelWrite
import hub.core.client.model.McpServer
import hub.core.client.model.McpServerPatch
import hub.core.client.model.McpServerWrite
import hub.core.client.model.PairingRequest
import hub.core.client.model.ProfileSettingsCompression
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/*
 * The rules of an agent's MCP servers, Settings cards and Channels pages (apps batch 9, Agents II),
 * apart from the screens so they are tested without drawing. They follow the web's
 * `agents/AgentMcpScreen.tsx`, `HubToolsCard.tsx`, `AgentSettingsScreen.tsx`, `CompressionSettingsCard.tsx`,
 * `AgentChannelsScreen.tsx`, `ChannelSettingsPanel.tsx` and `webhooks.ts`; iOS
 * `Screens/Agent/AgentsTwoRules.swift` is the twin.
 */

/** An MCP server edited as a form (a command or an address) or, for anything else, as its JSON. */
object McpRules {
    private val NAME = Regex("^[A-Za-z0-9._-]{1,60}$")

    /** A server's name, as the web accepts it. */
    fun validName(name: String): Boolean = NAME.matches(name)

    /** How the hub shows a credential it keeps: saving it unchanged keeps the one on file. */
    const val STORED = "[stored]"

    private val FORM_KEYS = setOf("command", "args", "env", "url", "headers", "enabled")

    enum class Kind { COMMAND, URL }

    /** One variable or header: its name, what was typed, and whether the hub holds a value already. */
    data class Row(val key: String = "", val value: String = "", val stored: Boolean = false)

    data class Draft(
        val kind: Kind = Kind.COMMAND,
        val command: String = "",
        /** One argument per line. */
        val args: String = "",
        val env: List<Row> = emptyList(),
        val url: String = "",
        val headers: List<Row> = emptyList(),
        /** Every other key of the server, kept as it is. */
        val rest: Map<String, JsonElement> = emptyMap(),
    )

    enum class Problem { COMMAND_REQUIRED, URL_BAD, ROW_BAD }

    /** What a new server starts as (the web's template). */
    val TEMPLATE = Draft(command = "npx", args = "-y\nsome-mcp-server")

    private fun text(value: JsonElement?): String = when (value) {
        null, is JsonNull -> ""
        is JsonPrimitive -> value.contentOrNull.orEmpty()
        else -> value.toString()
    }

    private fun rows(value: JsonElement?): List<Row> = (value as? JsonObject)?.map { (k, v) ->
        val shown = text(v)
        if (shown == STORED) Row(k, "", stored = true) else Row(k, shown)
    }.orEmpty()

    /** The form for a stored config; `enabled` is the row's switch, not a field. */
    fun draftOf(config: Map<String, JsonElement>): Draft = Draft(
        kind = if (config["url"] is JsonPrimitive && config["command"] == null) Kind.URL else Kind.COMMAND,
        command = text(config["command"]),
        args = (config["args"] as? JsonArray)?.joinToString("\n") { text(it) } ?: text(config["args"]),
        env = rows(config["env"]),
        url = text(config["url"]),
        headers = rows(config["headers"]),
        rest = config.filterKeys { it !in FORM_KEYS },
    )

    private fun block(rows: List<Row>): JsonObject? {
        val kept = rows.filter { it.key.isNotBlank() }
        if (kept.isEmpty()) return null
        return JsonObject(kept.associate { row -> row.key.trim() to JsonPrimitive(if (row.stored && row.value.isEmpty()) STORED else row.value) })
    }

    /** The config the form means: the kept keys, then what the form says for its kind. */
    fun configOf(draft: Draft): Map<String, JsonElement> = buildMap {
        putAll(draft.rest)
        when (draft.kind) {
            Kind.COMMAND -> {
                put("command", JsonPrimitive(draft.command.trim()))
                val args = draft.args.lines().map { it.trim() }.filter { it.isNotEmpty() }
                if (args.isNotEmpty()) put("args", JsonArray(args.map(::JsonPrimitive)))
                block(draft.env)?.let { put("env", it) }
            }
            Kind.URL -> {
                put("url", JsonPrimitive(draft.url.trim()))
                block(draft.headers)?.let { put("headers", it) }
            }
        }
    }

    private fun badRow(row: Row) = row.key.isNotBlank() && row.key.trim().any { it.isWhitespace() || it == '=' || it == ':' } ||
        row.key.isBlank() && row.value.isNotBlank()

    /** Why the form cannot be saved yet, or null. */
    fun problem(draft: Draft): Problem? = when (draft.kind) {
        Kind.COMMAND -> when {
            draft.command.isBlank() -> Problem.COMMAND_REQUIRED
            draft.env.any(::badRow) -> Problem.ROW_BAD
            else -> null
        }
        Kind.URL -> when {
            !Regex("^https?://\\S+$").matches(draft.url.trim()) -> Problem.URL_BAD
            draft.headers.any(::badRow) -> Problem.ROW_BAD
            else -> null
        }
    }

    /** The shape decides, as on the web: an address is a socket, a command a process. */
    fun transportOf(config: Map<String, JsonElement>): McpServerWrite.Transport =
        if (config["url"] is JsonPrimitive && config["command"] == null) McpServerWrite.Transport.HTTP else McpServerWrite.Transport.STDIO

    /** The transport to send with an edit: only when the form moved between a command and an address. */
    fun transportChange(server: McpServer, config: Map<String, JsonElement>): McpServerPatch.Transport? {
        val nowAddress = transportOf(config) == McpServerWrite.Transport.HTTP
        val wasAddress = server.transport != McpServer.Transport.STDIO
        return when {
            nowAddress == wasAddress -> null
            nowAddress -> McpServerPatch.Transport.HTTP
            else -> McpServerPatch.Transport.STDIO
        }
    }

    private val pretty = Json { prettyPrint = true }

    fun jsonOf(config: Map<String, JsonElement>): String = pretty.encodeToString(JsonObject.serializer(), JsonObject(config.filterKeys { it != "enabled" }))

    /** The text as a config: a JSON object, or null while it is not one. */
    fun parse(text: String): Map<String, JsonElement>? = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull()

    /** One line a person recognises the server by: what it runs, or where it points. */
    fun summary(server: McpServer): String {
        val url = server.config["url"]
        if (url is JsonPrimitive && url.isString) return url.content
        val command = text(server.config["command"])
        val args = (server.config["args"] as? JsonArray)?.joinToString(" ") { text(it) }.orEmpty()
        return listOf(command, args).filter { it.isNotEmpty() }.joinToString(" ")
    }

    /** The servers the page lists: not the hub's own block, which its card manages (decision §67). */
    fun listed(servers: List<McpServer>, hubServer: String?): List<McpServer> = servers.filter { it.name != (hubServer ?: "corehub") }

    /**
     * Whether Hermes gives the agent [name] under a server's `tools.include` / `tools.exclude`
     * (DECISIONS §134): the allow-list wins, then the block-list; entries are names or globs.
     */
    fun allowed(name: String, include: List<String>?, exclude: List<String>?): Boolean = when {
        include != null -> include.any { matches(name, it) }
        exclude != null -> exclude.none { matches(name, it) }
        else -> true
    }

    /** An exact name, or a glob (`*`, `?`, `[…]`, `[!…]`) matched as Hermes's `fnmatch` does. */
    fun matches(name: String, entry: String): Boolean {
        if (entry == name) return true
        if (entry.none { it == '*' || it == '?' || it == '[' }) return false
        val regex = StringBuilder()
        var i = 0
        while (i < entry.length) {
            val c = entry[i]
            when {
                c == '*' -> regex.append(".*")
                c == '?' -> regex.append('.')
                c == '[' && entry.indexOf(']', i + 2) != -1 -> {
                    val end = entry.indexOf(']', i + 2)
                    var body = entry.substring(i + 1, end)
                    val negate = body.startsWith("!")
                    if (negate) body = body.substring(1)
                    regex.append('[').append(if (negate) "^" else "").append(body.replace("\\", "\\\\").replace("^", "\\^")).append(']')
                    i = end
                }
                else -> regex.append(Regex.escape(c.toString()))
            }
            i++
        }
        return runCatching { Regex(regex.toString(), RegexOption.DOT_MATCHES_ALL).matches(name) }.getOrDefault(false)
    }

    /** The folded row's count from the kept test: how many tools the filter allows, of how many. */
    data class ToolCount(val allowed: Int, val total: Int, val filtered: Boolean)

    fun toolCount(names: List<String>, include: List<String>?, exclude: List<String>?): ToolCount =
        ToolCount(names.count { allowed(it, include, exclude) }, names.size, include != null || exclude != null)

    /** "0.8" seconds from a test's milliseconds, with a point whatever the language. */
    fun seconds(ms: Int): String = String.format(java.util.Locale.ROOT, "%.1f", ms / 1000.0)
}

/** An agent's own settings as the phone edits them: the web's per-field rules, `list` and `json` included. */
object SettingsCardRules {
    /** A `list` field as one item per line. */
    fun listText(value: JsonElement?): String = when (value) {
        is JsonArray -> value.joinToString("\n") { (it as? JsonPrimitive)?.contentOrNull ?: it.toString() }
        null, is JsonNull -> ""
        is JsonPrimitive -> value.contentOrNull.orEmpty()
        else -> value.toString()
    }

    fun listValue(text: String): JsonElement {
        val items = text.lines().map { it.trim() }.filter { it.isNotEmpty() }
        return if (items.isEmpty()) JsonNull else JsonArray(items.map(::JsonPrimitive))
    }

    private val pretty = Json { prettyPrint = true }

    fun jsonText(value: JsonElement?): String = if (value == null || value is JsonNull) "" else pretty.encodeToString(JsonElement.serializer(), value)

    /** The typed JSON, `JsonNull` for empty (the default back), or null while it is not JSON. */
    fun jsonValue(text: String): JsonElement? = if (text.isBlank()) JsonNull else runCatching { Json.parseToJsonElement(text) }.getOrNull()

    /** What a save said, as the web's section says it. */
    enum class Saved { RESTARTING, RESTART_NEEDED, NEXT_MESSAGE, SAVED }

    fun saved(restartJobId: String?, applies: hub.core.client.model.SettingsSection.Applies?): Saved = when {
        restartJobId != null -> Saved.RESTARTING
        applies == hub.core.client.model.SettingsSection.Applies.RESTART -> Saved.RESTART_NEEDED
        applies == hub.core.client.model.SettingsSection.Applies.NEXT_MESSAGE -> Saved.NEXT_MESSAGE
        else -> Saved.SAVED
    }
}

/** Context compression (decision §57): whole percentages on screen, ratios on the wire (web `CompressionSettingsCard`). */
object CompressionRules {
    data class Draft(
        val enabled: Boolean,
        val threshold: String,
        val target: String,
        val protectFirst: String,
        val protectLast: String,
        val contextLength: String,
    )

    enum class Field { THRESHOLD, TARGET, PROTECT_FIRST, PROTECT_LAST, CONTEXT_LENGTH }

    fun draftOf(c: ProfileSettingsCompression) = Draft(
        enabled = c.enabled,
        threshold = (c.threshold.toDouble() * 100).let { Math.round(it) }.toString(),
        target = (c.targetRatio.toDouble() * 100).let { Math.round(it) }.toString(),
        protectFirst = c.protectFirst.toString(),
        protectLast = c.protectLast.toString(),
        contextLength = c.contextLength?.toString().orEmpty(),
    )

    private fun whole(text: String): Int? = text.trim().takeIf { Regex("^\\d+$").matches(it) }?.toIntOrNull()

    /** The patch the draft means, or the first field that is not a valid number. */
    fun patchOf(draft: Draft): Result<Map<String, JsonElement>> {
        fun bad(field: Field) = Result.failure<Map<String, JsonElement>>(IllegalArgumentException(field.name))
        val threshold = whole(draft.threshold)?.takeIf { it in 1..100 } ?: return bad(Field.THRESHOLD)
        val target = whole(draft.target)?.takeIf { it in 1..100 } ?: return bad(Field.TARGET)
        val first = whole(draft.protectFirst) ?: return bad(Field.PROTECT_FIRST)
        val last = whole(draft.protectLast) ?: return bad(Field.PROTECT_LAST)
        val window = if (draft.contextLength.isBlank()) null else whole(draft.contextLength)?.takeIf { it >= 1024 } ?: return bad(Field.CONTEXT_LENGTH)
        return Result.success(
            mapOf(
                "enabled" to JsonPrimitive(draft.enabled),
                "threshold" to JsonPrimitive(threshold / 100.0),
                "target_ratio" to JsonPrimitive(target / 100.0),
                "protect_first" to JsonPrimitive(first),
                "protect_last" to JsonPrimitive(last),
                "context_length" to (window?.let(::JsonPrimitive) ?: JsonNull),
            ),
        )
    }

    fun invalid(result: Result<*>): Field? = result.exceptionOrNull()?.message?.let { runCatching { Field.valueOf(it) }.getOrNull() }
}

/** An agent's Channels page, as the web's (`AgentChannelsScreen.tsx`). */
object ChannelRules {
    /** Only what is linked, or what somebody waits on; Hermes's webhook receiver has its own section. */
    fun shown(items: List<Channel>, pending: List<PairingRequest>): List<Channel> {
        val waiting = pending.map { it.platform }.toSet()
        return items.filter { c -> c.platform != "webhook" && ((c.link?.linked ?: c.configured) || c.platform in waiting) }
    }

    fun waitingOn(pending: List<PairingRequest>, platform: String): Int = pending.count { it.platform == platform }

    fun linked(channel: Channel): Boolean = channel.link?.linked == true

    /** WhatsApp's mode once linked; null for every other platform. */
    fun mode(channel: Channel): ChannelLink.Mode? = if (channel.platform == "whatsapp" && linked(channel)) channel.link?.mode else null

    fun hasSettings(channel: Channel, spec: ChannelPlatform?): Boolean = (channel.platform == "telegram" || spec?.settings == true) && linked(channel)

    enum class Action { PAIR, LINK, SETTINGS, MODE, REPLY_HEADER, FIELDS, UNLINK, CLEAR }

    /** What a channel's card offers, in the web's order. */
    fun actions(channel: Channel, spec: ChannelPlatform?): List<Action> = buildList {
        val linked = linked(channel)
        if (channel.login == Channel.Login.QR && !linked) add(Action.PAIR)
        if ((channel.login == Channel.Login.TOKEN || (channel.login == Channel.Login.CREDENTIALS && spec != null)) && !linked) add(Action.LINK)
        if (hasSettings(channel, spec)) add(Action.SETTINGS)
        val mode = mode(channel)
        if (mode != null) add(Action.MODE)
        if (mode == ChannelLink.Mode.SELF_MINUS_CHAT) add(Action.REPLY_HEADER)
        if (channel.fields.isNotEmpty()) add(Action.FIELDS)
        if (linked) add(Action.UNLINK)
        if (channel.link == null && channel.configured) add(Action.CLEAR)
    }

    enum class UnlinkWords { TELEGRAM, CREDENTIALS, WHATSAPP }

    fun unlinkWords(channel: Channel): UnlinkWords = when {
        channel.platform == "telegram" -> UnlinkWords.TELEGRAM
        channel.login == Channel.Login.CREDENTIALS -> UnlinkWords.CREDENTIALS
        else -> UnlinkWords.WHATSAPP
    }

    /** The account in one line: its name, then its handle or number. */
    fun account(link: ChannelLink?): String? = link?.takeIf { it.linked }?.let { l ->
        listOfNotNull(l.accountName, l.accountUsername?.let { "@$it" }, l.accountPhone?.let { "+$it" }).joinToString(" · ").ifEmpty { null }
    }

    // ------------------------------------------------------------ the reply header (WhatsApp, self-chat)
    const val REPLY_TITLE_MAX = 64
    const val REPLY_RULE = "────────────"

    /** Custom when something other than the agent's name is written. */
    fun replyCustom(current: String?, agentName: String): Boolean = current != null && current != agentName

    fun replyTitle(custom: Boolean, agentName: String, typed: String): String =
        (if (custom) typed else agentName).replace(Regex("\\s+"), " ").trim()

    fun replyUsable(title: String): Boolean = title.isNotEmpty() && title.codePointCount(0, title.length) <= REPLY_TITLE_MAX

    // ------------------------------------------------------------ the fields editor
    /** Split the way the contract asks, from what each field declared itself to be. */
    fun write(fields: List<ChannelField>, draft: Map<String, JsonElement?>): ChannelWrite {
        val credentials = mutableMapOf<String, String>()
        val configuration = mutableMapOf<String, JsonElement>()
        for (field in fields) {
            val value = if (draft.containsKey(field.key)) draft[field.key] else field.value
            if (field.target == ChannelField.Target.CREDENTIALS) {
                (value as? JsonPrimitive)?.takeIf { it.isString }?.let { credentials[field.key] = it.content }
            } else {
                configuration[field.key] = value ?: JsonNull
            }
        }
        return ChannelWrite(credentials = credentials, configuration = configuration)
    }

    fun fieldText(value: JsonElement?): String = when (value) {
        is JsonPrimitive -> if (value.isString) value.content else value.toString()
        is JsonArray -> value.joinToString(", ") { (it as? JsonPrimitive)?.contentOrNull ?: it.toString() }
        else -> ""
    }

    fun fieldOn(value: JsonElement?): Boolean = (value as? JsonPrimitive)?.booleanOrNull == true
}

/** A channel's own settings (web `ChannelSettingsPanel.tsx`): gathered, then saved together (one gateway restart). */
object ChannelSettingRules {
    val SECTIONS = listOf(ChannelSetting.Section.ACCESS, ChannelSetting.Section.REPLIES, ChannelSetting.Section.GROUPS, ChannelSetting.Section.MEDIA, ChannelSetting.Section.ADVANCED)

    /** Comma-, space- or Arabic-comma-separated ids, as a person types them. */
    fun idsOf(text: String): List<String> = text.split(Regex("[\\s,،]+")).map { it.trim() }.filter { it.isNotEmpty() }

    /** What the option is now: the draft's, else the stored value (null: its default applies). */
    fun current(option: ChannelSetting, draft: Map<String, JsonElement>): JsonElement? =
        if (draft.containsKey(option.key)) draft[option.key] else option.value

    fun effective(option: ChannelSetting, draft: Map<String, JsonElement>): JsonElement? =
        current(option, draft)?.takeIf { it !is JsonNull } ?: option.default

    /** A text or list or number shown in its field. */
    fun shown(option: ChannelSetting, draft: Map<String, JsonElement>): String = when (val value = current(option, draft)) {
        null, is JsonNull -> ""
        is JsonArray -> value.joinToString(", ") { (it as? JsonPrimitive)?.contentOrNull ?: it.toString() }
        is JsonPrimitive -> value.contentOrNull.orEmpty()
        else -> value.toString()
    }

    /** What was typed into a text-like option: empty is back to the default. */
    fun typed(text: String): JsonElement = if (text.isEmpty()) JsonNull else JsonPrimitive(text)

    /** A number within the option's range, or not. */
    fun numberOk(option: ChannelSetting, text: String): Boolean {
        if (text.isBlank()) return true
        val n = text.trim().toIntOrNull() ?: return false
        return (option.min == null || n >= option.min!!) && (option.max == null || n <= option.max!!)
    }

    /** The draft as the values the hub takes: lists as arrays, numbers as numbers, null for the default. */
    fun values(options: List<ChannelSetting>, draft: Map<String, JsonElement>): Map<String, JsonElement> = draft.mapValues { (key, value) ->
        val option = options.firstOrNull { it.key == key }
        val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
        when {
            option == null || text == null -> value
            option.kind == ChannelSetting.Kind.LIST -> JsonArray(idsOf(text).map(::JsonPrimitive))
            option.kind == ChannelSetting.Kind.NUMBER -> text.trim().toIntOrNull()?.let(::JsonPrimitive) ?: JsonNull
            else -> value
        }
    }

    /** The draft's problems: the keys of numbers out of range. */
    fun problems(options: List<ChannelSetting>, draft: Map<String, JsonElement>): Set<String> = options.filter { option ->
        option.kind == ChannelSetting.Kind.NUMBER && draft[option.key]?.let { v -> (v as? JsonPrimitive)?.takeIf { it.isString }?.let { !numberOk(option, it.content) } } == true
    }.map { it.key }.toSet()

    /** The option's default in words: null when there is none (or an empty list). */
    sealed interface Default {
        data object None : Default
        data class On(val on: Boolean) : Default
        data class Choice(val value: String) : Default
        data class Text(val text: String) : Default
    }

    fun default(option: ChannelSetting): Default {
        val value = option.default
        return when {
            value == null || value is JsonNull || (value is JsonArray && value.isEmpty()) -> Default.None
            value is JsonPrimitive && value.booleanOrNull != null && !value.isString -> Default.On(value.booleanOrNull == true)
            option.kind == ChannelSetting.Kind.SELECT -> Default.Choice((value as? JsonPrimitive)?.contentOrNull ?: value.toString())
            value is JsonArray -> Default.Text(value.joinToString(", ") { (it as? JsonPrimitive)?.contentOrNull ?: it.toString() })
            else -> Default.Text((value as? JsonPrimitive)?.contentOrNull ?: value.toString())
        }
    }
}

/** Hermes's incoming webhooks under the channels (decision §97, web `webhooks.ts`). */
object WebhookRules {
    private val NAME = Regex("^[a-z0-9][a-z0-9_-]{0,63}$")

    enum class NameProblem { INVALID, TAKEN }

    fun nameProblem(typed: String, taken: Set<String>): NameProblem? {
        val name = typed.trim().lowercase()
        return when {
            name.isEmpty() -> null
            !NAME.matches(name) -> NameProblem.INVALID
            name in taken -> NameProblem.TAKEN
            else -> null
        }
    }

    fun ready(name: String, prompt: String, taken: Set<String>): Boolean =
        name.isNotBlank() && nameProblem(name, taken) == null && prompt.isNotBlank()

    /** `issues, push` → `[issues, push]`. */
    fun eventsOf(text: String): List<String> = text.split(Regex("[,،\\s]+")).map { it.trim() }.filter { it.isNotEmpty() }.distinct()

    /** The route's address: the hub's origin, then the route's path. */
    fun url(hub: String, path: String): String = hub.trimEnd('/') + path

    /** Where an answer may go: the log, or a channel switched on and set up. */
    fun targets(channels: List<Channel>): List<Channel> = channels.filter { it.platform != "webhook" && it.enabled && it.configured }

    fun accepted(status: Int): Boolean = status in 200..299
}
