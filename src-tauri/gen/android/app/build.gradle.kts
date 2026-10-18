import org.gradle.api.DefaultTask
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.TaskAction
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

abstract class WriteShioriDistributionManifestTask : DefaultTask() {
    @get:Input
    abstract val distribution: Property<String>

    @get:OutputFile
    abstract val outputFile: RegularFileProperty

    @TaskAction
    fun write() {
        val manifestFile = outputFile.get().asFile
        manifestFile.parentFile.mkdirs()

        val installPackagesPermission =
            if (distribution.get() == "direct-apk") {
                """    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />"""
            } else {
                ""
            }

        manifestFile.writeText(
            """
            <?xml version="1.0" encoding="utf-8"?>
            <manifest xmlns:android="http://schemas.android.com/apk/res/android">
            $installPackagesPermission
            </manifest>
            """.trimIndent() + "\n"
        )
    }
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val signingProperties = Properties().apply {
    val propFile = rootProject.file("key.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val shioriAndroidDistribution =
    (System.getenv("SHIORI_ANDROID_DISTRIBUTION") ?: "google-play")
        .takeIf { it == "google-play" || it == "direct-apk" }
        ?: "google-play"

android {
    compileSdk = 36
    namespace = "fun.nagi.shiori"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        manifestPlaceholders["shioriAndroidDistribution"] = shioriAndroidDistribution
        applicationId = "fun.nagi.shiori"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        buildConfigField(
            "String",
            "SHIORI_ANDROID_DISTRIBUTION",
            "\"$shioriAndroidDistribution\""
        )
    }
    signingConfigs {
        create("release") {
            val storeFilePath = signingProperties.getProperty("storeFile")
            if (!storeFilePath.isNullOrBlank()) {
                storeFile = rootProject.file(storeFilePath)
                storePassword = signingProperties.getProperty("storePassword")
                keyAlias = signingProperties.getProperty("keyAlias")
                keyPassword = signingProperties.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            if (signingProperties.isNotEmpty()) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

androidComponents {
    onVariants { variant ->
        val capitalizedVariantName = variant.name.replaceFirstChar {
            if (it.isLowerCase()) it.titlecase() else it.toString()
        }
        val manifestTask =
            tasks.register<WriteShioriDistributionManifestTask>(
                "write${capitalizedVariantName}ShioriDistributionManifest"
            ) {
                distribution.set(shioriAndroidDistribution)
                outputFile.set(
                    layout.buildDirectory.file(
                        "generated/shiori/${variant.name}/AndroidManifest.xml"
                    )
                )
            }

        variant.sources.manifests.addGeneratedManifestFile(
            manifestTask,
            WriteShioriDistributionManifestTask::outputFile
        )
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
