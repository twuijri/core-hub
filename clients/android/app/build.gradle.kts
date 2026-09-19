import org.gradle.api.tasks.PathSensitivity

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// A stable signing key means every build can install over the previous one.
// Without it Gradle falls back to a debug key that CI regenerates per run, which
// makes Android reject the update with "App not installed".
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_PATH")
val keystorePassword: String? = System.getenv("ANDROID_KEYSTORE_PASSWORD")
val keystoreAlias: String? = System.getenv("ANDROID_KEY_ALIAS")
val hasSigningKey = !keystorePath.isNullOrBlank() && file(keystorePath).exists()
val buildCommit = System.getenv("GITHUB_SHA")?.takeIf { it.matches(Regex("[0-9a-fA-F]{40}")) } ?: "local"

android {
    namespace = "us.i3u.hermesstudio"
    compileSdk = 35

    defaultConfig {
        // Store identity of Core Hub Mobile (owner decision 2026-09-19); the Kotlin
        // package/namespace stays us.i3u.hermesstudio.
        applicationId = "com.twuijri.corehub"
        minSdk = 26
        targetSdk = 35
        // Core Hub Mobile follows the Core Hub version: CI passes the core
        // package.json version (test builds: <core>-test.<run>) and the run
        // number; local builds fall back to the values below.
        versionCode = System.getenv("CORE_HUB_VERSION_CODE")?.toIntOrNull() ?: 34
        versionName = System.getenv("CORE_HUB_VERSION_NAME")?.takeIf { it.isNotBlank() } ?: "1.4.0"
        buildConfigField("String", "BUILD_COMMIT", "\"$buildCommit\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (hasSigningKey) {
            create("shared") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                keyAlias = keystoreAlias
                keyPassword = keystorePassword
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            if (hasSigningKey) signingConfig = signingConfigs.getByName("shared")
        }
        release {
            isMinifyEnabled = false
            signingConfig = if (hasSigningKey) {
                signingConfigs.getByName("shared")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }

    // The app changes language at runtime; every App Bundle must carry both
    // translations instead of letting Play split one of them away.
    bundle {
        language {
            enableSplit = false
        }
    }
}

// TranslationsTest reads the resource files straight off disk, so Gradle has to
// be told they are inputs — otherwise a broken translation looks up to date.
tasks.withType<Test>().configureEach {
    inputs.dir("src/main/res").withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file("src/main/java/us/i3u/hermesstudio/Locales.kt")
    // AttachmentSheetTest compares the two clients' attachment sheet, so an
    // iOS-only edit has to invalidate this task too.
    inputs.dir("../../ios/HermesStudio").withPathSensitivity(PathSensitivity.RELATIVE)
    testLogging { events("failed") }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.2")
    implementation(platform("androidx.compose:compose-bom:2026.06.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.security:security-crypto:1.1.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Talks to the server's /chat-run and /group-chat namespaces, so replies
    // stream in as they are written instead of arriving all at once.
    implementation("io.socket:socket.io-client:2.1.2") {
        exclude(group = "org.json", module = "json")
    }
    // Draws the Multiavatar SVG Studio generates for a profile without a picture.
    implementation("com.caverock:androidsvg-aar:1.4")
    // Remote Petdex previews and active data-URI spritesheets.
    implementation("io.coil-kt:coil-compose:2.6.0")
    implementation("com.google.zxing:core:3.5.3")
    // Reads the Core Hub App-connection QR code on the login screen. Ships its
    // own capture activity, so no CameraX or ML Kit payload is added to the APK.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test:runner:1.5.2")
}
