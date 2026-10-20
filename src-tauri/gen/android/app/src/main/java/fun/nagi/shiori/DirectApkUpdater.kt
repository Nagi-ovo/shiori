package `fun`.nagi.shiori

import android.content.Intent
import android.content.pm.PackageInfo
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import org.json.JSONObject

// The direct-APK updater (SHIORI_ANDROID_DISTRIBUTION=direct-apk builds only):
// download, verify and hand the APK to the system installer. Split out of
// MainActivity.kt; the bridge entry point there starts it on a worker thread.

internal fun MainActivity.installDirectApkInBackground(request: AndroidApkUpdateRequest) {
  try {
    validateOfficialApkUrl(request.url)
    emitAndroidUpdateEvent(
      AndroidUpdateEvent(
        id = request.id,
        status = "progress",
        downloaded = 0,
        total = request.size.takeIf { it > 0 },
      ),
    )
    val apk = downloadApk(request)
    validateDownloadedApk(request, apk)
    requestApkInstall(request.id, apk)
  } catch (error: Exception) {
    emitAndroidUpdateEvent(
      AndroidUpdateEvent(
        id = request.id,
        status = "error",
        message = error.message ?: "android-update-failed",
      ),
    )
  }
}

private fun MainActivity.validateOfficialApkUrl(urlValue: String) {
  val uri = Uri.parse(urlValue)
  if (uri.scheme != "https" || uri.host != "github.com") {
    throw IllegalArgumentException("android-update-url-not-allowed")
  }
  val path = uri.path ?: ""
  // Mirrors OFFICIAL_APK_PATH_PREFIXES in src/platform/androidUpdatePolicy.ts.
  val officialPrefixes = listOf("/Nagi-ovo/shiori/releases/download/")
  if (officialPrefixes.none { path.startsWith(it) } || !path.endsWith(".apk")) {
    throw IllegalArgumentException("android-update-url-not-allowed")
  }
}

private fun MainActivity.downloadApk(request: AndroidApkUpdateRequest): File {
  val updatesDir = File(cacheDir, "updates")
  if (!updatesDir.exists()) updatesDir.mkdirs()
  updatesDir.listFiles()?.forEach { file -> file.delete() }

  val filename = sanitizeApkFilename(request.filename)
  val target = File(updatesDir, filename)
  val digest = MessageDigest.getInstance("SHA-256")
  val connection = (URL(request.url).openConnection() as HttpURLConnection).apply {
    instanceFollowRedirects = true
    connectTimeout = 15_000
    readTimeout = 30_000
    setRequestProperty("User-Agent", "Shiori-Android-Updater/${BuildConfig.VERSION_NAME}")
  }

  val responseCode = connection.responseCode
  if (responseCode !in 200..299) {
    throw IllegalStateException("android-update-download-failed-$responseCode")
  }

  connection.inputStream.use { input ->
    val declaredTotal = request.size.takeIf { it > 0 }
      ?: connection.contentLengthLong.takeIf { it > 0 }
    var downloaded = 0L
    var lastProgressAt = 0L
    val buffer = ByteArray(64 * 1024)
    target.outputStream().use { output ->
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        output.write(buffer, 0, read)
        digest.update(buffer, 0, read)
        downloaded += read.toLong()
        val now = System.currentTimeMillis()
        if (now - lastProgressAt >= 250L) {
          lastProgressAt = now
          emitAndroidUpdateEvent(
            AndroidUpdateEvent(
              id = request.id,
              status = "progress",
              downloaded = downloaded,
              total = declaredTotal,
            ),
          )
        }
      }
    }

    if (request.size > 0 && downloaded != request.size) {
      throw IllegalStateException("android-update-size-mismatch")
    }
    val expectedSha256 = request.sha256.lowercase()
    val actualSha256 = digest.digest().joinToString("") { byte -> "%02x".format(byte) }
    if (actualSha256 != expectedSha256) {
      throw IllegalStateException("android-update-sha256-mismatch")
    }

    emitAndroidUpdateEvent(
      AndroidUpdateEvent(
        id = request.id,
        status = "progress",
        downloaded = downloaded,
        total = declaredTotal ?: downloaded,
      ),
    )
    return target
  }
}

private fun MainActivity.validateDownloadedApk(request: AndroidApkUpdateRequest, apk: File) {
  val packageInfo = packageManager.getPackageArchiveInfo(apk.absolutePath, 0)
    ?: throw IllegalStateException("android-update-apk-invalid")
  if (packageInfo.packageName != packageName) {
    throw IllegalStateException("android-update-package-mismatch")
  }

  val candidateVersion = longVersionCode(packageInfo)
  val currentVersion = longVersionCode(packageManager.getPackageInfo(packageName, 0))
  if (candidateVersion <= currentVersion) {
    throw IllegalStateException("android-update-version-not-newer")
  }

  if (!request.version.isNullOrBlank() && packageInfo.versionName != request.version) {
    throw IllegalStateException("android-update-version-mismatch")
  }
}

private fun MainActivity.requestApkInstall(id: String, apk: File) {
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
    val settingsIntent = Intent(
      Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
      Uri.parse("package:$packageName"),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runOnUiThread { startActivity(settingsIntent) }
    throw IllegalStateException("android-install-permission-required")
  }

  val apkUri = FileProvider.getUriForFile(
    this,
    "$packageName.fileprovider",
    apk,
  )
  val installIntent = Intent(Intent.ACTION_VIEW).apply {
    setDataAndType(apkUri, "application/vnd.android.package-archive")
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
  }
  runOnUiThread {
    try {
      startActivity(installIntent)
      emitAndroidUpdateEvent(AndroidUpdateEvent(id = id, status = "complete"))
    } catch (error: Exception) {
      emitAndroidUpdateEvent(
        AndroidUpdateEvent(
          id = id,
          status = "error",
          message = error.message ?: "android-install-launch-failed",
        ),
      )
    }
  }
}

private fun MainActivity.longVersionCode(info: PackageInfo): Long {
  return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
    info.longVersionCode
  } else {
    @Suppress("DEPRECATION")
    info.versionCode.toLong()
  }
}

private fun MainActivity.sanitizeApkFilename(filename: String): String {
  val clean = filename
    .substringAfterLast('/')
    .replace(Regex("[^A-Za-z0-9._-]"), "_")
    .takeIf { it.endsWith(".apk", ignoreCase = true) }
    ?: "Shiori.apk"
  if (clean.length <= 160) return clean.ifBlank { "Shiori.apk" }
  return "${clean.dropLast(4).take(156)}.apk"
}

internal data class AndroidApkUpdateRequest(
  val id: String,
  val url: String,
  val filename: String,
  val size: Long,
  val sha256: String,
  val version: String?,
) {
  companion object {
    fun fromJson(json: JSONObject): AndroidApkUpdateRequest {
      val id = json.optString("id").takeIf { it.isNotBlank() }
        ?: throw IllegalArgumentException("android-update-id-missing")
      val url = json.optString("url").takeIf { it.isNotBlank() }
        ?: throw IllegalArgumentException("android-update-url-missing")
      val sha256 = json.optString("sha256")
        .trim()
        .takeIf { it.matches(Regex("^[0-9a-fA-F]{64}$")) }
        ?: throw IllegalArgumentException("android-update-sha256-missing")
      return AndroidApkUpdateRequest(
        id = id,
        url = url,
        filename = json.optString("filename", "Shiori.apk"),
        size = json.optLong("size", 0L).takeIf { it > 0 } ?: 0L,
        sha256 = sha256,
        version = json.optString("version").takeIf { it.isNotBlank() },
      )
    }
  }
}

internal data class AndroidUpdateEvent(
  val id: String,
  val status: String,
  val downloaded: Long? = null,
  val total: Long? = null,
  val message: String? = null,
) {
  fun toJson(): JSONObject {
    val json = JSONObject()
      .put("id", id)
      .put("status", status)
    if (downloaded != null && downloaded >= 0) json.put("downloaded", downloaded)
    if (total != null && total > 0) json.put("total", total)
    if (!message.isNullOrBlank()) json.put("message", message)
    return json
  }
}
