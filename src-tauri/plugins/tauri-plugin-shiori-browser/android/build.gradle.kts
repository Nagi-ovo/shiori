plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.tauri.shioribrowser"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.6.0")
    // Profile / ProfileStore for the temporary browser session; same
    // version as the app module.
    implementation("androidx.webkit:webkit:1.14.0")
    // Provided by the app's generated Android project (gen/android) — the Tauri
    // CLI includes this plugin as a Gradle module on the first `tauri android`
    // build and wires `:tauri-android` for it.
    implementation(project(":tauri-android"))
}
