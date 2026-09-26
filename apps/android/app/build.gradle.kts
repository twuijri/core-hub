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
    @get:OutputDirectory abstract val output: DirectoryProperty
    @get:OutputDirectory abstract val resOutput: DirectoryProperty

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
            appendLine("}")
        }
    }
}

val generateSharedSources by tasks.registering(GenerateSharedSources::class) {
    tokens.set(File(repoRoot, "packages/ui-tokens/tokens.json"))
    product.set(File(repoRoot, "packages/contracts/src/product.ts"))
    navigation.set(File(repoRoot, "docs/clients/navigation.json"))
    output.set(layout.buildDirectory.dir("generated/shared/kotlin"))
    resOutput.set(layout.buildDirectory.dir("generated/shared/res"))
}

android {
    namespace = "hub.core.android"
    compileSdk = 35

    defaultConfig {
        // The store identity (owner, 2026-09-25): Firebase's Android app and the Play listing use
        // it. The Kotlin packages keep `hub.core.android` (the `namespace`); the two need not match.
        applicationId = "com.twuijri.corehub"
        // 26 (Android 8.0): the generated client speaks java.time (dateLibrary java8), which
        // Android has from API 26 without core-library desugaring; adaptive icons and the
        // notification channels the app posts to are 26+ as well. Below 26 is ~1% of devices.
        minSdk = 26
        targetSdk = 35
        // The signed-build workflow stamps its run number + 100 so each build a store sees is newer,
        // and newer than the old app's (same id, up to 63). A local or pull-request build is 1.
        versionCode = providers.environmentVariable("COREHUB_ANDROID_VERSION_CODE").orNull?.toIntOrNull() ?: 1
        versionName = rootVersion
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("boolean", "FIREBASE", hasFirebase.toString())
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
    sourceSets["main"].java.srcDir(generateSharedSources.flatMap { it.output })
    sourceSets["main"].res.srcDir(generateSharedSources.flatMap { it.resOutput })
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
