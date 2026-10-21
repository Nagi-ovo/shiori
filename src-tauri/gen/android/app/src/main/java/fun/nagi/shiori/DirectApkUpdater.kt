package `fun`.nagi.shiori

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
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
  // Uri does not normalise the path the way the TS URL check does, so
  // refuse what it would have rewritten: dot segments (decoded, so %2e%2e
  // counts) and encoded separators that would escape the prefix once the
  // request is sent, plus a port, credentials, query or fragment.
  val unsafeSegment = uri.pathSegments.any { segment ->
    segment == "." || segment == ".." || segment.contains('/') || segment.contains('\\')
  }
  if (
    uri.scheme != "https" || uri.host != "github.com" || uri.port != -1 ||
    uri.userInfo != null || uri.query != null || uri.fragment != null || unsafeSegment
  ) {
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

  // A PackageInstaller session rather than ACTION_VIEW on the APK: the
  // session reports how the install ended, so a refusal (signature conflict,
  // Play Protect) or a tap on Cancel reaches the update modal. ACTION_VIEW
  // gave no result, and "complete" on launch closed the modal over the old
  // version. The status receiver below emits complete or error.
  val installer = packageManager.packageInstaller
  val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
  params.setAppPackageName(packageName)
  // createSession throws too (no space, restricted user): inside the try,
  // so it also reaches the modal as a slug.
  var createdSession: Int? = null
  var receiver: BroadcastReceiver? = null
  try {
    val sessionId = installer.createSession(params)
    createdSession = sessionId
    installer.openSession(sessionId).use { session ->
      session.openWrite("shiori.apk", 0, apk.length()).use { output ->
        apk.inputStream().use { input -> input.copyTo(output) }
        session.fsync(output)
      }
      val action = "$packageName.APK_INSTALL_STATUS.$sessionId"
      receiver = registerApkInstallStatusReceiver(id, sessionId, action)
      // Mutable: the installer fills in EXTRA_STATUS. Explicit (setPackage),
      // as Android 14 requires of a mutable PendingIntent.
      val statusIntent = Intent(action).setPackage(packageName)
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or
        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
      val pending = PendingIntent.getBroadcast(this, sessionId, statusIntent, flags)
      session.commit(pending.intentSender)
    }
  } catch (error: Exception) {
    receiver?.let { unregisterApkInstallStatusReceiver(it) }
    createdSession?.let { created ->
      try {
        installer.abandonSession(created)
      } catch (_: Exception) {
        // Already committed or gone; nothing left to clean up.
      }
    }
    // A slug, not error.message: the modal translates slugs and would show
    // raw Java exception text otherwise.
    throw IllegalStateException("android-install-launch-failed", error)
  }
}

private fun MainActivity.registerApkInstallStatusReceiver(
  id: String,
  sessionId: Int,
  action: String,
): BroadcastReceiver {
  val activity = this
  val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
      if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
        // The system confirmation dialog. Its outcome arrives as a second
        // broadcast to this receiver (Cancel and Back report ABORTED).
        val confirm = pendingUserActionIntent(intent)
        try {
          if (confirm == null) throw IllegalStateException("no confirmation intent")
          activity.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
          return
        } catch (_: Exception) {
          try {
            activity.packageManager.packageInstaller.abandonSession(sessionId)
          } catch (_: Exception) {
            // Already gone.
          }
          activity.unregisterApkInstallStatusReceiver(this)
          activity.emitAndroidUpdateEvent(
            AndroidUpdateEvent(id = id, status = "error", message = "android-install-launch-failed"),
          )
          return
        }
      }
      activity.unregisterApkInstallStatusReceiver(this)
      // On success Android usually replaces this process before the event
      // reaches the page; the new version then launches on its own.
      val event = when (status) {
        PackageInstaller.STATUS_SUCCESS -> AndroidUpdateEvent(id = id, status = "complete")
        PackageInstaller.STATUS_FAILURE_ABORTED ->
          AndroidUpdateEvent(id = id, status = "error", message = "android-install-cancelled")
        else -> AndroidUpdateEvent(id = id, status = "error", message = "android-install-failed")
      }
      activity.emitAndroidUpdateEvent(event)
    }
  }
  // The application context outlives an activity recreation mid-install.
  ContextCompat.registerReceiver(
    applicationContext,
    receiver,
    IntentFilter(action),
    ContextCompat.RECEIVER_NOT_EXPORTED,
  )
  return receiver
}

private fun MainActivity.unregisterApkInstallStatusReceiver(receiver: BroadcastReceiver) {
  try {
    applicationContext.unregisterReceiver(receiver)
  } catch (_: IllegalArgumentException) {
    // Already unregistered.
  }
}

private fun pendingUserActionIntent(intent: Intent): Intent? {
  return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
  } else {
    @Suppress("DEPRECATION")
    intent.getParcelableExtra(Intent.EXTRA_INTENT) as? Intent
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
