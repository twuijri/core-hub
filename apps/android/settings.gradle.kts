// Core Hub for Android (ADR 0007): a client built from scratch on packages/contracts and
// docs/clients/navigation.json. `:client` is the Kotlin client generated from the contract
// (`pnpm contracts:generate:native`); `:app` is the Compose application.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "corehub-android"
include(":client", ":app")
