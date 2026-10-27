import groovy.json.JsonSlurper

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Firebase (FCM) reads its project from app/google-services.json, which is never committed: the
// signed-build workflow writes it from a secret. A pull request, a fork or a local build has no
// file and builds without the plugin; Firebase Messaging is still linked, never starts, and the
// app says push is not in this build and keeps polling (BuildConfig.FIREBASE, PushManager).
val hasFirebase = file("google-services.json").exists()
if (hasFirebase) apply(plugin = "com.google.gms.google-services")

val repoRoot = rootProject.file("../..")

// Self-update from the GitHub releases (phone/SelfUpdate.kt, docs/RELEASING.md): on for the APK the
// GitHub release carries, off for a Google Play build — Play updates the app and forbids an app
// installing its own updates. `-Pcorehub.selfUpdate=false` or COREHUB_ANDROID_SELF_UPDATE=false turns
// it off: the app never asks GitHub, and REQUEST_INSTALL_PACKAGES leaves the manifest.
val selfUpdate = when (
    val v = (providers.gradleProperty("corehub.selfUpdate").orNull ?: providers.environmentVariable("COREHUB_ANDROID_SELF_UPDATE").orNull)
        ?.trim()?.lowercase()
) {
    null, "", "true", "1" -> true
    "false", "0" -> false
    else -> throw GradleException("corehub.selfUpdate / COREHUB_ANDROID_SELF_UPDATE must be true or false, not \"$v\"")
}

// One version for every Core Hub deliverable (owner, 2026-09-26): the root package.json's.
// `pnpm version:check` fails if versionName stops being read from it (docs/RELEASING.md).
@Suppress("UNCHECKED_CAST")
val rootVersion = (JsonSlurper().parse(File(repoRoot, "package.json")) as Map<String, Any?>)["version"] as String

/**
 * The shared design tokens (packages/ui-tokens/tokens.json) and the product's names
 * (packages/contracts/src/product.ts) become Kotlin at build time, so the app never carries a
 * second, hand-kept copy of either (docs/clients/DESIGN.md: the tokens are the single source).
 */
abstract class GenerateSharedSources : DefaultTask() {
    @get:InputFile abstract val tokens: RegularFileProperty
    @get:InputFile abstract val product: RegularFileProperty
    @get:InputFile abstract val navigation: RegularFileProperty
    /** The UI languages (locales/languages.json, ADR 0028). */
    @get:InputFile abstract val languages: RegularFileProperty
    /** The app's words, one JSON catalogue per language and area (apps/android/i18n). */
    @get:InputDirectory abstract val strings: DirectoryProperty
    @get:OutputDirectory abstract val output: DirectoryProperty
    @get:OutputDirectory abstract val resOutput: DirectoryProperty
    /** Test-only pseudo-locale resources (en-XA, ar-XB, zh-XC, th-XD): the debug build only. */
    @get:OutputDirectory abstract val pseudoResOutput: DirectoryProperty

    @TaskAction
    fun generate() {
        @Suppress("UNCHECKED_CAST")
        val json = JsonSlurper().parse(tokens.get().asFile) as Map<String, Any?>
        val out = output.get().asFile.resolve("hub/core/android/generated")
        out.mkdirs()
        out.resolve("Tokens.kt").writeText(tokensKotlin(json))
        out.resolve("Product.kt").writeText(productKotlin(product.get().asFile.readText()))
        @Suppress("UNCHECKED_CAST")
        val nav = JsonSlurper().parse(navigation.get().asFile) as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val terms = (nav["terms"] as Map<String, Map<String, String>>).filterKeys { !it.startsWith("$") }
        val res = resOutput.get().asFile
        val productSource = product.get().asFile.readText()
        fun productName(key: String) = Regex("\\b$key: '([^']*)'").find(productSource)?.groupValues?.get(1)
            ?: throw GradleException("product.ts: `$key` not found")
        for ((dir, lang) in listOf("values" to "en", "values-ar" to "ar")) {
            res.resolve(dir).mkdirs()
            res.resolve("$dir/terms.xml").writeText(termsXml(terms, lang))
            val name = productName(if (lang == "ar") "nameAr" else "name")
            res.resolve("$dir/product.xml").writeText(
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generated from packages/contracts/src/product.ts. Do not edit. -->\n" +
                    "<resources>\n    <string name=\"app_name\">${xml(name)}</string>\n</resources>\n",
            )
        }
        out.resolve("Terms.kt").writeText(termsKotlin(terms.keys))
        generateStrings(res, out, pseudoResOutput.get().asFile, terms)
        @Suppress("UNCHECKED_CAST")
        val surfaces = nav["surfaceRoutes"] as Map<String, Map<String, String>>
        @Suppress("UNCHECKED_CAST")
        val preAuth = (nav["preAuth"] as Map<String, Any?>).filterKeys { !it.startsWith("$") }
            .mapValues { (_, v) -> ((v as Map<String, Any?>)["routes"] as Map<String, String>)["android"] }
        out.resolve("SurfaceRoutes.kt").writeText(
            buildString {
                appendLine("// Generated from docs/clients/navigation.json by :app:generateSharedSources. Do not edit.")
                appendLine("package hub.core.android.generated")
                appendLine()
                appendLine("/** Each destination's path per surface (`surfaceRoutes`) and the Android pre-auth screens. */")
                appendLine("object SurfaceRoutes {")
                for (surface in listOf("web", "android")) {
                    appendLine("    val $surface: Map<String, String> = mapOf(")
                    surfaces[surface].orEmpty().filterKeys { !it.startsWith("$") }
                        .forEach { (id, path) -> appendLine("        \"$id\" to \"$path\",") }
                    appendLine("    )")
                }
                appendLine("    val preAuthAndroid: Map<String, String> = mapOf(")
                preAuth.forEach { (id, path) -> if (path != null) appendLine("        \"$id\" to \"$path\",") }
                appendLine("    )")
                appendLine("}")
            },
        )
    }


    // ---- the app's words (ADR 0028) ---------------------------------------------------------
    // Translators edit apps/android/i18n/<area>.<lang>.json; the string resources are written from
    // them here, one values folder per registered language. English is the default `values`: a
    // key a language lacks is resolved along its fallback chain first (zh-Hant → zh-Hans), and
    // only what no language before English has is left to Android's own fallback to `values`.

    @Suppress("UNCHECKED_CAST")
    private fun generateStrings(res: File, out: File, pseudoRes: File, terms: Map<String, Map<String, String>>) {
        val registry = JsonSlurper().parse(languages.get().asFile) as Map<String, Any?>
        val langs = (registry["languages"] as List<Map<String, Any?>>)
        val codes = langs.map { it["code"] as String }
        val fallbacks = langs.associate { (it["code"] as String) to (it["fallback"] as List<String>) }
        val dir = strings.get().asFile
        fun catalogue(code: String): Map<String, Any?> {
            val files = (dir.listFiles() ?: emptyArray()).filter { it.name == "$code.json" || it.name.endsWith(".$code.json") }
                .sortedBy { if (it.name == "$code.json") "" else it.name }
            val merged = linkedMapOf<String, Any?>()
            for (file in files) {
                val parsed = JsonSlurper().parse(file) as Map<String, Any?>
                for ((key, value) in parsed) {
                    if (key.startsWith("$")) continue
                    if (key in merged) throw GradleException("apps/android/i18n: \"$key\" is in ${file.name} and another $code file")
                    merged[key] = value
                }
            }
            return merged
        }
        val all = codes.associateWith { catalogue(it) }
        val english = all.getValue("en")
        if (english.isEmpty()) throw GradleException("apps/android/i18n/en.json is missing or empty")
        fun filled(value: Any?) = when (value) {
            is String -> value.isNotBlank()
            is Map<*, *> -> (value["other"] as? String)?.isNotBlank() == true
            else -> false
        }
        for (code in codes) {
            val chain = (listOf(code) + fallbacks.getValue(code)).distinct().filter { it != "en" || code == "en" }
            val folder = res.resolve(valuesFolder(code))
            folder.mkdirs()
            val xml = StringBuilder()
            xml.appendLine("<?xml version=\"1.0\" encoding=\"utf-8\"?>")
            xml.appendLine("<!-- Generated from apps/android/i18n (${code}) by :app:generateSharedSources. Do not edit: translate the JSON. -->")
            xml.appendLine("<resources>")
            for (key in english.keys) {
                val value = chain.asSequence().map { all.getValue(it)[key] }.firstOrNull { filled(it) } ?: continue
                when (value) {
                    is String -> {
                        val unformatted = value.contains('%') && !Regex("%\\d+\\$").containsMatchIn(value) && !value.contains("%%")
                        xml.appendLine("    <string name=\"$key\"${if (unformatted) " formatted=\"false\"" else ""}>${resourceText(value)}</string>")
                    }
                    is Map<*, *> -> {
                        xml.appendLine("    <plurals name=\"$key\">")
                        for (quantity in listOf("zero", "one", "two", "few", "many", "other")) {
                            val text = value[quantity] as? String ?: continue
                            if (text.isBlank()) continue
                            xml.appendLine("        <item quantity=\"$quantity\">${resourceText(text)}</item>")
                        }
                        xml.appendLine("    </plurals>")
                    }
                }
            }
            xml.appendLine("</resources>")
            folder.resolve("catalogue.xml").writeText(xml.toString())
        }
        // The pseudo-locales, from their base language's words (ADR 0028): tests only, debug only.
        for (p in registry["pseudo"] as List<Map<String, Any?>>) {
            val style = p["style"] as String
            if (style == "tagged") continue
            val code = p["code"] as String
            val base = all.getValue(p["base"] as String)
            val folder = pseudoRes.resolve("values-${pseudoResourceTag(code).replace("-", "-r")}")
            folder.mkdirs()
            val xml = StringBuilder()
            xml.appendLine("<?xml version=\"1.0\" encoding=\"utf-8\"?>")
            xml.appendLine("<!-- Generated test-only pseudo-locale $code by :app:generateSharedSources. Never shipped in a release. -->")
            xml.appendLine("<resources>")
            // The navigation terms (terms.xml) in the pseudo-locale too.
            val baseLang = p["base"] as String
            terms.forEach { (key, value) ->
                val text = value[baseLang] ?: value.getValue("en")
                xml.appendLine("    <string name=\"term_$key\">${resourceText(pseudoize(text, style))}</string>")
            }
            for (key in english.keys) {
                val value = base[key]?.takeIf { filled(it) } ?: english[key] ?: continue
                when (value) {
                    is String -> {
                        val unformatted = value.contains('%') && !Regex("%\\d+\\$").containsMatchIn(value) && !value.contains("%%")
                        xml.appendLine("    <string name=\"$key\"${if (unformatted) " formatted=\"false\"" else ""}>${resourceText(pseudoize(value, style))}</string>")
                    }
                    is Map<*, *> -> {
                        xml.appendLine("    <plurals name=\"$key\">")
                        for (quantity in listOf("zero", "one", "two", "few", "many", "other")) {
                            val text = value[quantity] as? String ?: continue
                            if (text.isBlank()) continue
                            xml.appendLine("        <item quantity=\"$quantity\">${resourceText(pseudoize(text, style))}</item>")
                        }
                        xml.appendLine("    </plurals>")
                    }
                }
            }
            xml.appendLine("</resources>")
            folder.resolve("catalogue.xml").writeText(xml.toString())
        }
        // The languages Android offers for this app in its own settings (Android 13+).
        res.resolve("xml").mkdirs()
        res.resolve("xml/locales_config.xml").writeText(
            buildString {
                appendLine("<?xml version=\"1.0\" encoding=\"utf-8\"?>")
                appendLine("<!-- Generated from locales/languages.json by :app:generateSharedSources. Do not edit. -->")
                appendLine("<locale-config xmlns:android=\"http://schemas.android.com/apk/res/android\">")
                codes.forEach { appendLine("    <locale android:name=\"$it\" />") }
                appendLine("</locale-config>")
            },
        )
        out.resolve("Languages.kt").writeText(
            buildString {
                appendLine("// Generated from locales/languages.json by :app:generateSharedSources. Do not edit.")
                appendLine("package hub.core.android.generated")
                appendLine()
                appendLine("/** One UI language of the registry (ADR 0028). */")
                appendLine("data class LanguageInfo(")
                appendLine("    val code: String,")
                appendLine("    val englishName: String,")
                appendLine("    val nativeName: String,")
                appendLine("    val rtl: Boolean,")
                appendLine("    val fallback: List<String>,")
                appendLine(")")
                appendLine()
                appendLine("/** The registry's languages in its order, and its test-only pseudo-locales. */")
                appendLine("object Languages {")
                appendLine("    val all: List<LanguageInfo> = listOf(")
                for (l in langs) {
                    val fb = (l["fallback"] as List<String>).joinToString(", ") { "\"$it\"" }
                    appendLine("        LanguageInfo(\"${l["code"]}\", \"${kotlinText(l["englishName"] as String)}\", \"${kotlinText(l["nativeName"] as String)}\", ${l["direction"] == "rtl"}, listOf($fb)),")
                }
                appendLine("    )")
                val pseudo = registry["pseudo"] as List<Map<String, Any?>>
                appendLine("    /** Test-only pseudo-locales: never offered to a person. */")
                appendLine("    val pseudo: List<LanguageInfo> = listOf(")
                for (p in pseudo) {
                    if (p["style"] == "tagged") continue
                    appendLine("        LanguageInfo(\"${p["code"]}\", \"${p["code"]}\", \"${p["code"]}\", ${p["direction"] == "rtl"}, listOf(\"${p["base"]}\")),")
                    appendLine("        // resources: values-${pseudoResourceTag(p["code"] as String).replace("-", "-r")}")
                }
                appendLine("    )")
                appendLine("}")
            },
        )
    }


    // ---- pseudo-locales: the same transforms as packages/contracts/src/languages.ts ----------
    private val accentedMap = mapOf(
        'a' to "á", 'b' to "ƀ", 'c' to "ç", 'd' to "ð", 'e' to "é", 'f' to "ƒ", 'g' to "ĝ", 'h' to "ĥ", 'i' to "î", 'j' to "ĵ",
        'k' to "ķ", 'l' to "ļ", 'm' to "ɱ", 'n' to "ñ", 'o' to "ö", 'p' to "þ", 'q' to "ǫ", 'r' to "ŕ", 's' to "š", 't' to "ţ",
        'u' to "û", 'v' to "ṽ", 'w' to "ŵ", 'x' to "ẋ", 'y' to "ý", 'z' to "ž", 'A' to "Å", 'B' to "Ɓ", 'C' to "Ç", 'D' to "Ð",
        'E' to "É", 'F' to "Ƒ", 'G' to "Ĝ", 'H' to "Ĥ", 'I' to "Î", 'J' to "Ĵ", 'K' to "Ķ", 'L' to "Ļ", 'M' to "Ṁ", 'N' to "Ñ",
        'O' to "Ö", 'P' to "Þ", 'Q' to "Ǫ", 'R' to "Ŕ", 'S' to "Š", 'T' to "Ţ", 'U' to "Û", 'V' to "Ṽ", 'W' to "Ŵ", 'X' to "Ẋ",
        'Y' to "Ý", 'Z' to "Ž",
    )
    private val han = "设置聊天任务模型代理文件记忆频道工具技能搜索新建删除保存取消确认打开关闭显示隐藏更多帮助用户账户通知隐私更新插件日志用量性能主题语言"
    private val thaiLetters = "กขคฆงจฉชซญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ"
    private val thaiAbove = listOf("\u0E34\u0E48", "\u0E35\u0E49", "\u0E36\u0E4A", "\u0E37\u0E4B", "\u0E31\u0E49")
    private val thaiBelow = listOf("\u0E38", "\u0E39")
    private val joinsNext = "بتثجحخسشصضطظعغفقكلمنهيئ"
    private val placeholder = Regex("%\\d+\\$[sdf]|%%|\\{[A-Za-z0-9_]+\\}")

    private fun pseudoize(text: String, style: String): String {
        val body = StringBuilder()
        var at = 0
        for (m in placeholder.findAll(text)) {
            body.append(pseudoWords(text.substring(at, m.range.first), style)).append(m.value)
            at = m.range.last + 1
        }
        body.append(pseudoWords(text.substring(at), style))
        return when (style) {
            "long-rtl" -> "«$body»"
            "accented" -> {
                val plain = text.replace(placeholder, "").length
                val made = body.toString().replace(placeholder, "").length
                val short = Math.ceil(plain * 1.4).toInt() - made
                "[$body${if (short > 0) " " + "ẋ".repeat(maxOf(short - 1, 3)) else ""}]"
            }
            else -> "[$body]"
        }
    }

    private fun pseudoWords(text: String, style: String): String = when (style) {
        "accented" -> text.map { c -> val m = accentedMap[c] ?: c.toString(); if (c in "aeiouAEIOU") m + m else m }.joinToString("")
        "long-rtl" -> buildString { text.forEachIndexed { i, c -> append(c); if (c in joinsNext && i % 2 == 0) append("\u0640\u0640") } }
        "cjk" -> buildString {
            var seed = 0
            for (word in text.split(' ').filter { it.isNotEmpty() }) {
                val letters = word.count { it in 'a'..'z' || it in 'A'..'Z' }
                val count = if (letters == 0) 0 else maxOf(1, Math.ceil(letters * 0.6).toInt())
                for (i in 0 until count) append(han[(seed + i * 7) % han.length])
                seed += count + 3
                word.filter { !(it in 'a'..'z' || it in 'A'..'Z') }.forEach {
                    append(when (it) { ':' -> '：'; '?' -> '？'; '!' -> '！'; ',' -> '，'; '.' -> '。'; else -> it })
                }
            }
        }
        "tall" -> buildString {
            var i = 0
            for (c in text) {
                if (c in 'a'..'z' || c in 'A'..'Z') {
                    append(thaiLetters[c.code % thaiLetters.length])
                    if (i % 2 == 0) append(thaiAbove[i % thaiAbove.size]) else if (i % 3 == 0) append(thaiBelow[i % thaiBelow.size])
                    i++
                } else append(c)
            }
        }
        else -> text
    }

    /**
     * The locale a pseudo-locale's resources are filed under. en-XA and ar-XB are Android's own
     * reserved pseudo-locales, which its resource matching treats apart, so they are filed as
     * en-XL and ar-XR and the app asks for those (`AppLanguage.resourceTag`).
     */
    private fun pseudoResourceTag(code: String) = when (code) {
        "en-XA" -> "en-XL"
        "ar-XB" -> "ar-XR"
        else -> code
    }

    private fun kotlinText(text: String) = text.replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "\\$")

    /** `ar` → values-ar, `en` → values, `pt-BR` → values-pt-rBR, `zh-Hant` → values-b+zh+Hant. */
    private fun valuesFolder(code: String): String {
        if (code == "en") return "values"
        val parts = code.split('-')
        return when {
            parts.size == 1 -> "values-$code"
            parts.size == 2 && parts[1].length == 2 && parts[1].all { it.isUpperCase() } -> "values-${parts[0]}-r${parts[1]}"
            else -> "values-b+" + parts.joinToString("+")
        }
    }

    /** A string as a resource value that aapt reads back to exactly this text. */
    private fun resourceText(text: String): String {
        val sb = StringBuilder()
        text.forEachIndexed { i, c ->
            when {
                c == '\\' -> sb.append("\\\\")
                c == '\'' -> sb.append("\\'")
                c == '"' -> sb.append("\\\"")
                c == '\n' -> sb.append("\\n")
                c == '\t' -> sb.append("\\t")
                c == '&' -> sb.append("&amp;")
                c == '<' -> sb.append("&lt;")
                c == '>' -> sb.append("&gt;")
                i == 0 && (c == '@' || c == '?') -> sb.append('\\').append(c)
                c == ' ' && (i == 0 || i == text.length - 1 || text.getOrNull(i + 1) == ' ') -> sb.append("\\u0020")
                else -> sb.append(c)
            }
        }
        return sb.toString()
    }

    private fun xml(text: String) = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("'", "\\'").replace("\"", "\\\"")

    /** The navigation terms (docs/clients/navigation.json) as string resources `term_<key>`. */
    private fun termsXml(terms: Map<String, Map<String, String>>, lang: String) = buildString {
        appendLine("<?xml version=\"1.0\" encoding=\"utf-8\"?>")
        appendLine("<!-- Generated from docs/clients/navigation.json by :app:generateSharedSources. Do not edit. -->")
        appendLine("<resources>")
        terms.forEach { (key, value) ->
            appendLine("    <string name=\"term_$key\">${xml(value.getValue(lang))}</string>")
        }
        appendLine("</resources>")
    }

    private fun termsKotlin(keys: Set<String>) = buildString {
        appendLine("// Generated from docs/clients/navigation.json by :app:generateSharedSources. Do not edit.")
        appendLine("package hub.core.android.generated")
        appendLine()
        appendLine("import hub.core.android.R")
        appendLine()
        appendLine("/** Every navigation term's string resource, by its key in navigation.json. */")
        appendLine("object Terms {")
        appendLine("    val ids: Map<String, Int> = mapOf(")
        keys.forEach { appendLine("        \"$it\" to R.string.term_$it,") }
        appendLine("    )")
        appendLine("}")
    }

    private fun color(hex: String): String {
        val h = hex.removePrefix("#")
        val argb = when (h.length) {
            6 -> "FF$h"
            8 -> h.substring(6) + h.substring(0, 6)
            else -> throw GradleException("tokens.json: colour $hex is not #rrggbb or #rrggbbaa")
        }
        return "Color(0x${argb.uppercase()})"
    }

    private fun ident(key: String): String =
        key.split('-').mapIndexed { i, p -> if (i == 0) p else p.replaceFirstChar(Char::uppercase) }
            .joinToString("")

    /** `1.25rem` → 20 (dp), `0` → 0, `9999px` → 9999. */
    private fun dp(value: String): String {
        val v = value.trim()
        val n = when {
            v.endsWith("rem") -> v.removeSuffix("rem").toDouble() * 16
            v.endsWith("px") -> v.removeSuffix("px").toDouble()
            else -> v.toDouble()
        }
        return "${n}f"
    }

    @Suppress("UNCHECKED_CAST")
    private fun tokensKotlin(json: Map<String, Any?>): String {
        val themes = json["themes"] as Map<String, Map<String, String>>
        val light = themes.getValue("light")
        val dark = themes.getValue("dark")
        if (light.keys != dark.keys) throw GradleException("tokens.json: light and dark differ in keys")
        val sb = StringBuilder()
        sb.appendLine("// Generated from packages/ui-tokens/tokens.json by :app:generateSharedSources. Do not edit.")
        sb.appendLine("package hub.core.android.generated")
        sb.appendLine()
        sb.appendLine("import androidx.compose.ui.graphics.Color")
        sb.appendLine()
        sb.appendLine("/** Every colour role of one theme, named as in tokens.json. */")
        sb.appendLine("data class TokenColors(")
        light.keys.forEach { sb.appendLine("    val ${ident(it)}: Color,") }
        sb.appendLine(")")
        sb.appendLine()
        for ((name, theme) in listOf("LightTokens" to light, "DarkTokens" to dark)) {
            sb.appendLine("val $name = TokenColors(")
            theme.forEach { (k, v) -> sb.appendLine("    ${ident(k)} = ${color(v)},") }
            sb.appendLine(")")
            sb.appendLine()
        }
        val glass = json["glass"] as Map<String, Any?>
        val levels = glass["levels"] as Map<String, Map<String, Any?>>
        sb.appendLine("/** The glass scale for floating chrome: 0 solid … 3 full. */")
        sb.appendLine("data class GlassLevel(val blurDp: Float, val alpha: Float, val borderAlpha: Float)")
        sb.appendLine()
        sb.appendLine("object Glass {")
        sb.appendLine("    const val DEFAULT = ${glass["default"]}")
        sb.appendLine("    val levels = listOf(")
        levels.toSortedMap().forEach { (_, l) ->
            sb.appendLine(
                "        GlassLevel(${dp(l["blur"].toString())}, ${l["alpha"]}f, ${l["borderAlpha"]}f),",
            )
        }
        sb.appendLine("    )")
        sb.appendLine("}")
        sb.appendLine()
        for (group in listOf("space", "radius")) {
            val values = json[group] as Map<String, String>
            sb.appendLine("/** `$group` from tokens.json, in dp (1rem = 16dp). */")
            sb.appendLine("object ${group.replaceFirstChar(Char::uppercase)}Tokens {")
            values.filterKeys { !it.startsWith("$") }.forEach { (k, v) ->
                val name = if (k.first().isDigit()) "s$k" else ident(k)
                sb.appendLine("    const val $name = ${dp(v)}")
            }
            sb.appendLine("}")
            sb.appendLine()
        }
        val control = json["control"] as Map<String, String>
        sb.appendLine("/** The controls' sizes from tokens.json (`control`): three heights, concentric radii, in dp. */")
        sb.appendLine("object ControlTokens {")
        control.filterKeys { !it.startsWith("$") }.filterValues { it.endsWith("rem") }.forEach { (k, v) ->
            sb.appendLine("    const val ${ident(k)} = ${dp(v)}")
        }
        sb.appendLine("}")
        sb.appendLine()
        val layout = json["layout"] as Map<String, String>
        sb.appendLine("/** Layout sizes from tokens.json that make sense on a phone, in dp. */")
        sb.appendLine("object LayoutTokens {")
        layout.filterValues { it.endsWith("rem") }.forEach { (k, v) ->
            sb.appendLine("    const val ${ident(k)} = ${dp(v)}")
        }
        sb.appendLine("    const val bubbleMaxFraction = ${layout.getValue("bubble-max").removeSuffix("%").toDouble() / 100}f")
        sb.appendLine("}")
        val font = json["font"] as Map<String, String>
        sb.appendLine()
        sb.appendLine("/** Type sizes from tokens.json, in sp (1rem = 16sp). */")
        sb.appendLine("object FontTokens {")
        font.filterValues { it.endsWith("rem") }.forEach { (k, v) ->
            sb.appendLine("    const val ${ident(k)} = ${dp(v)}")
        }
        font.filterKeys { it.startsWith("leading-") }.forEach { (k, v) ->
            sb.appendLine("    const val ${ident(k)} = ${v}f")
        }
        sb.appendLine("}")
        return sb.toString()
    }

    private fun productKotlin(source: String): String {
        fun block(name: String): String =
            Regex("export const $name = \\{(.*?)\\} as const", RegexOption.DOT_MATCHES_ALL)
                .find(source)?.groupValues?.get(1)
                ?: throw GradleException("product.ts: `$name` not found")
        fun field(block: String, key: String): String =
            Regex("\\b$key: '([^']*)'").find(block)?.groupValues?.get(1)
                ?: throw GradleException("product.ts: `$key` not found")
        val product = block("PRODUCT")
        val legacy = block("LEGACY")
        val links = block("PRODUCT_LINKS")
        val id = field(product, "id")
        return buildString {
            appendLine("// Generated from packages/contracts/src/product.ts by :app:generateSharedSources. Do not edit.")
            appendLine("package hub.core.android.generated")
            appendLine()
            appendLine("/** The product's names (ADR 0017); a rename is one edit in product.ts. */")
            appendLine("object Product {")
            appendLine("    const val ID = \"$id\"")
            appendLine("    const val NAME = \"${field(product, "name")}\"")
            appendLine("    const val NAME_AR = \"${field(product, "nameAr")}\"")
            appendLine("    /** The pairing QR's `type` (`derived.pairingType`). */")
            appendLine("    const val PAIRING_TYPE = \"$id.pairing\"")
            appendLine("    /** What hubs from before the rename wrote (`LEGACY.pairingType`). */")
            appendLine("    const val LEGACY_PAIRING_TYPE = \"${field(legacy, "pairingType")}\"")
            appendLine("    /** The deep-link scheme, as on the desktop app (`corehub://pair?…`). */")
            appendLine("    const val SCHEME = \"$id\"")
            appendLine("    /** The repository on GitHub (`PRODUCT_LINKS.repository`): About and the drawer. */")
            appendLine("    const val REPOSITORY_URL = \"${field(links, "repository")}\"")
            appendLine("    /** The download page `site/` publishes (`PRODUCT_LINKS.downloadPage`): About. */")
            appendLine("    const val DOWNLOAD_PAGE_URL = \"${field(links, "downloadPage")}\"")
            appendLine("}")
        }
    }
}

val generateSharedSources by tasks.registering(GenerateSharedSources::class) {
    tokens.set(File(repoRoot, "packages/ui-tokens/tokens.json"))
    product.set(File(repoRoot, "packages/contracts/src/product.ts"))
    navigation.set(File(repoRoot, "docs/clients/navigation.json"))
    languages.set(File(repoRoot, "locales/languages.json"))
    strings.set(File(repoRoot, "apps/android/i18n"))
    output.set(layout.buildDirectory.dir("generated/shared/kotlin"))
    resOutput.set(layout.buildDirectory.dir("generated/shared/res"))
    pseudoResOutput.set(layout.buildDirectory.dir("generated/shared/pseudo-res"))
}

android {
    namespace = "hub.core.android"
    compileSdk = 36

    defaultConfig {
        // The store identity (owner, 2026-09-25): Firebase's Android app and the Play listing use
        // it. The Kotlin packages keep `hub.core.android` (the `namespace`); the two need not match.
        applicationId = "com.twuijri.corehub"
        // 26 (Android 8.0): the generated client speaks java.time (dateLibrary java8), which
        // Android has from API 26 without core-library desugaring; adaptive icons and the
        // notification channels the app posts to are 26+ as well. Below 26 is ~1% of devices.
        minSdk = 26
        targetSdk = 36
        // The signed-build workflow stamps its run number + 100 so each build a store sees is newer,
        // and newer than the old app's (same id, up to 63). A local or pull-request build is 1.
        versionCode = providers.environmentVariable("COREHUB_ANDROID_VERSION_CODE").orNull?.toIntOrNull() ?: 1
        versionName = rootVersion
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("boolean", "FIREBASE", hasFirebase.toString())
        buildConfigField("boolean", "SELF_UPDATE", selfUpdate.toString())
    }

    // A signed release needs the keystore (docs/RELEASING.md): CI writes it from the repository's
    // secrets and passes its path and passwords in these variables. Without them a release build
    // stays unsigned, as on a pull request or a fork.
    val releaseKeystore = providers.environmentVariable("COREHUB_ANDROID_KEYSTORE").orNull
    if (releaseKeystore != null) {
        signingConfigs {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = providers.environmentVariable("COREHUB_ANDROID_KEYSTORE_PASSWORD").get()
                keyAlias = providers.environmentVariable("COREHUB_ANDROID_KEY_ALIAS").get()
                keyPassword = providers.environmentVariable("COREHUB_ANDROID_KEY_PASSWORD").get()
            }
        }
    }

    buildTypes {
        release {
            if (releaseKeystore != null) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    // Without self-update the app has no reason to install packages (Play's policy on the permission).
    if (!selfUpdate) {
        sourceSets["debug"].manifest.srcFile("src/noSelfUpdate/AndroidManifest.xml")
        sourceSets["release"].manifest.srcFile("src/noSelfUpdate/AndroidManifest.xml")
    }
    sourceSets["main"].java.srcDir(generateSharedSources.flatMap { it.output })
    sourceSets["main"].res.srcDir(generateSharedSources.flatMap { it.resOutput })
    // The test-only pseudo-locales ship in the debug build only (ADR 0028), never in a release.
    sourceSets["debug"].res.srcDir(generateSharedSources.flatMap { it.pseudoResOutput })
    // The navigation manifest is read by the parity test from the repository, never copied by hand.
    sourceSets["test"].resources.srcDir(File(repoRoot, "docs/clients"))
    testOptions {
        unitTests.isReturnDefaultValues = true
        // Robolectric reads the merged manifest and resources (the Compose UI tests).
        unitTests.isIncludeAndroidResources = true
        unitTests.all { it.systemProperty("corehub.repoRoot", repoRoot.absolutePath) }
    }
    lint {
        abortOnError = true
        checkReleaseBuilds = false
        disable += listOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion", "OldTargetApi")
        // A language partly translated reads English for the rest, on purpose (ADR 0028).
        disable += "MissingTranslation"
    }
    packaging { resources.excludes += listOf("META-INF/{AL2.0,LGPL2.1}", "META-INF/versions/9/OSGI-INF/MANIFEST.MF") }
}

tasks.named("preBuild") { dependsOn(generateSharedSources) }

dependencies {
    implementation(project(":client"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.work)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.socketio.client) { exclude(group = "org.json", module = "json") }
    implementation(libs.zxing.embedded) { isTransitive = false }
    implementation(libs.zxing.core)
    implementation(libs.commonmark)
    implementation(libs.commonmark.tables)
    implementation(libs.commonmark.strikethrough)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    // Android's own org.json is a stub under unit tests; the real one parses the socket payloads.
    testImplementation(libs.json)
    // Reads packages/contracts/openapi.yaml so the contract's own examples are decoded by the client.
    testImplementation(libs.snakeyaml)
    // Compose UI tests on the JVM (Robolectric): the keyboard and drawer behaviour, no emulator.
    // They live in src/testDebug: ComponentActivity comes from ui-test-manifest, a debug-only library.
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.junit)
    debugImplementation(libs.compose.ui.test.manifest)
}
