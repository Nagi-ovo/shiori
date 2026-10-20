package `fun`.nagi.shiori

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  // Touched from the main thread (onCreate/onNewIntent enqueue) and the
  // WebView JavaBridge thread (bridge drain); every access must hold
  // synchronized(pendingDocumentOpens). @Synchronized cannot express this:
  // on activity methods it locks the activity, on the inner bridge method it
  // locks the bridge instance — two different monitors, no mutual exclusion.
  private val pendingDocumentOpens = mutableListOf<DocumentOpenPayload>()

  // Owned by the main thread: the bridge entry point posts via runOnUiThread.
  private var immersiveEnabled = false

  // System bar insets in CSS px, as last published to the page. Written on
  // the main thread by the insets listener, read on the WebView JavaBridge
  // thread when a page that loaded after the last change pulls them.
  @Volatile
  private var currentSafeArea = SafeAreaInsets(top = 0f, bottom = 0f, left = 0f, right = 0f)

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    applySystemBarInsets()
    // A recreated activity (process death) or a relaunch from Recents gets
    // the task's original VIEW/SEND intent back; its URI grant is usually
    // gone, so opening it again only reports an error or duplicates a tab.
    val replayed = savedInstanceState != null ||
      (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0
    if (!replayed) enqueueDocumentIntent(intent)
    // The export share chooser's only reliable feedback is the
    // "user picked a target" broadcast (dismissal emits nothing) — the
    // frontend marks an export as shared only after this fires.
    ContextCompat.registerReceiver(
      this,
      exportShareChosenReceiver,
      IntentFilter(exportShareChosenAction),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
  }

  override fun onDestroy() {
    try {
      unregisterReceiver(exportShareChosenReceiver)
    } catch (_: IllegalArgumentException) {
      // Already unregistered — nothing to clean up.
    }
    super.onDestroy()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    webView.addJavascriptInterface(ShioriAndroidBridge(), "ShioriAndroid")
    notifyPendingDocumentUris()
    publishSafeAreaInsets(currentSafeArea)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    enqueueDocumentIntent(intent)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // System dialogs (share sheet, permission prompts) can bring the bars
    // back; re-assert the immersive state when focus returns.
    if (hasFocus && immersiveEnabled) applyImmersiveMode(true)
  }

  private fun applyImmersiveMode(enabled: Boolean) {
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    if (enabled) {
      controller.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      controller.show(WindowInsetsCompat.Type.systemBars())
    }
  }

  // The WebView is laid out edge to edge, under the transparent system bars
  // (enableEdgeToEdge), and the page reserves the room itself from the
  // `--shiori-safe-*` CSS variables published below — so every bar sits on
  // the page's own chrome colour. Padding this view for the bars instead
  // showed the Activity window background (white, or the night default) as
  // a band under Shiori's status bar: the "misaligned bottom" on Android.
  // WebView reports only display cutouts through env(safe-area-inset-*),
  // never the system bars, so the page cannot learn them any other way.
  //
  // The keyboard still shrinks the view: a page cannot scroll under an IME,
  // and while it is up the navigation bar is inside the keyboard's inset.
  private fun applySystemBarInsets() {
    val content = window.decorView.findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime()) && ime.bottom > 0
      view.setPadding(0, 0, 0, if (imeVisible) ime.bottom else 0)
      val density = resources.displayMetrics.density
      publishSafeAreaInsets(
        SafeAreaInsets(
          top = bars.top / density,
          bottom = (if (imeVisible) 0 else bars.bottom) / density,
          left = bars.left / density,
          right = bars.right / density,
        ),
      )
      // Consumed: AppCompat's sub-decor (fitsSystemWindows) is a child of
      // this view and would otherwise pad for the same bars a second time.
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
  }

  private fun publishSafeAreaInsets(insets: SafeAreaInsets) {
    currentSafeArea = insets
    val view = webView ?: return
    val json = insets.toJson().toString()
    view.post {
      view.evaluateJavascript(
        """
          window.dispatchEvent(new CustomEvent("shiori-android-safe-area", { detail: $json }));
        """.trimIndent(),
        null,
      )
    }
  }

  private fun applySystemBarsAppearance(dark: Boolean) {
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.isAppearanceLightStatusBars = !dark
    controller.isAppearanceLightNavigationBars = !dark
  }

  private fun enqueueDocumentIntent(intent: Intent?) {
    if (intent == null) return
    val uris = when (intent.action) {
      Intent.ACTION_VIEW -> listOfNotNull(intent.data)
      Intent.ACTION_SEND -> streamUris(intent)
      Intent.ACTION_SEND_MULTIPLE -> streamUris(intent)
      else -> emptyList()
    }
    // Resolve payloads (contentResolver query) before taking the lock.
    val documentUris = uris.filter { uri -> uri.scheme == "content" || uri.scheme == "file" }
    // A link or text selection: no stream, only EXTRA_TEXT (SharedText.kt).
    val sharedText = if (intent.action == Intent.ACTION_SEND && documentUris.isEmpty()) {
      sharedTextDocumentUri(intent)
    } else {
      null
    }
    val payloads = (documentUris + listOfNotNull(sharedText))
      .map { uri -> documentOpenPayload(uri) }
      .distinct()
    synchronized(pendingDocumentOpens) {
      payloads.forEach { payload ->
        if (pendingDocumentOpens.none { it.uri == payload.uri }) {
          pendingDocumentOpens.add(payload)
        }
      }
    }
    notifyPendingDocumentUris()
  }

  private fun streamUris(intent: Intent): List<Uri> {
    val uris = mutableListOf<Uri>()
    singleStreamUri(intent)?.let { uri -> uris.add(uri) }
    multipleStreamUris(intent)?.let { list -> uris.addAll(list) }
    intent.clipData?.let { clipData ->
      for (index in 0 until clipData.itemCount) {
        clipData.getItemAt(index).uri?.let { uri -> uris.add(uri) }
      }
    }
    return uris.distinctBy { uri -> uri.toString() }
  }

  private fun singleStreamUri(intent: Intent): Uri? {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
    }
  }

  private fun multipleStreamUris(intent: Intent): List<Uri>? {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
    }
  }

  private val exportShareChosenAction: String
    get() = "$packageName.EXPORT_SHARE_CHOSEN"

  private val exportShareChosenReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      notifyExportShareChosen()
    }
  }

  private fun notifyExportShareChosen() {
    val view = webView ?: return
    view.post {
      view.evaluateJavascript(
        """
          window.dispatchEvent(new CustomEvent("shiori-android-share-chosen"));
        """.trimIndent(),
        null,
      )
    }
  }

  private fun notifyPendingDocumentUris() {
    val view = webView ?: return
    val hasPending = synchronized(pendingDocumentOpens) { pendingDocumentOpens.isNotEmpty() }
    if (!hasPending) return
    view.post {
      view.evaluateJavascript(
        """
          window.dispatchEvent(new CustomEvent("shiori-android-file-open"));
        """.trimIndent(),
        null,
      )
    }
  }

  internal fun emitAndroidUpdateEvent(event: AndroidUpdateEvent) {
    val view = webView ?: return
    val eventJson = event.toJson().toString()
    view.post {
      view.evaluateJavascript(
        """
          window.dispatchEvent(new CustomEvent("shiori-android-update", { detail: $eventJson }));
        """.trimIndent(),
        null,
      )
    }
  }

  private fun documentOpenPayload(uri: Uri): DocumentOpenPayload {
    val info = documentInfoForUri(uri)
    return DocumentOpenPayload(
      uri = uri.toString(),
      name = info.name,
      size = info.size,
    )
  }

  private fun documentInfoForUri(uri: Uri): DocumentInfo {
    val fallbackName = uri.lastPathSegment?.takeIf { it.isNotBlank() }
    if (uri.scheme.isNullOrBlank()) {
      return DocumentInfo(
        name = uri.path?.substringAfterLast('/')?.takeIf { it.isNotBlank() },
        size = null,
      )
    }

    if (uri.scheme == "file") {
      return DocumentInfo(
        name = fallbackName,
        size = null,
      )
    }

    if (uri.scheme != "content") {
      return DocumentInfo(name = fallbackName, size = null)
    }

    return try {
      contentResolver.query(
        uri,
        arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
        null,
        null,
        null,
      )?.use { cursor ->
        if (!cursor.moveToFirst()) return DocumentInfo(name = null, size = null)
        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
        val name = if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
          cursor.getString(nameIndex)?.takeIf { it.isNotBlank() }
        } else {
          null
        }
        val size = if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
          cursor.getLong(sizeIndex).takeIf { it >= 0 }
        } else {
          null
        }
        DocumentInfo(name = name ?: fallbackName, size = size)
      } ?: DocumentInfo(name = fallbackName, size = null)
    } catch (_: Exception) {
      DocumentInfo(name = fallbackName, size = null)
    }
  }

  private inner class ShioriAndroidBridge {
    @JavascriptInterface
    fun drainPendingDocumentOpens(): String {
      // Copy-and-clear atomically so an enqueue between the two steps can
      // neither be wiped undelivered nor mutate the list mid-iteration.
      val opens = synchronized(pendingDocumentOpens) {
        val drained = pendingDocumentOpens.toList()
        pendingDocumentOpens.clear()
        drained
      }
      return JSONArray(opens.map { payload -> payload.toJson() }).toString()
    }

    @JavascriptInterface
    fun documentInfo(uriValue: String): String {
      return try {
        val uri = Uri.parse(uriValue)
        documentOpenPayload(uri).toJson().toString()
      } catch (_: Exception) {
        DocumentOpenPayload(uri = uriValue, name = null, size = null).toJson().toString()
      }
    }

    @JavascriptInterface
    fun shareExport(requestValue: String): String {
      return try {
        val request = AndroidShareExportRequest.fromJson(JSONObject(requestValue))
        shareCachedExport(request)
        // awaitChoice tells the frontend this shell reports the user's
        // share-target pick via "shiori-android-share-chosen"; older shells
        // without it keep the legacy launched-equals-saved semantics.
        JSONObject().put("ok", true).put("awaitChoice", true).toString()
      } catch (error: Exception) {
        bridgeResult(ok = false, message = error.message ?: "android-share-export-failed")
      }
    }

    @JavascriptInterface
    fun setImmersive(enabled: Boolean): String {
      // Called on the WebView JavaBridge thread; window/insets APIs are
      // main-thread only.
      runOnUiThread {
        immersiveEnabled = enabled
        applyImmersiveMode(enabled)
      }
      return bridgeResult(ok = true, message = null)
    }

    // The page pulls these once at load: the push above may have fired
    // before the page existed (first navigation, a reload).
    @JavascriptInterface
    fun safeAreaInsets(): String = currentSafeArea.toJson().toString()

    // Status/navigation bar icon polarity follows the page's colour scheme,
    // not the OS: Shiori dark under a light OS otherwise keeps dark icons on
    // a dark top bar.
    @JavascriptInterface
    fun setSystemBarsAppearance(dark: Boolean): String {
      runOnUiThread { applySystemBarsAppearance(dark) }
      return bridgeResult(ok = true, message = null)
    }

    @JavascriptInterface
    fun installDirectApk(requestValue: String): String {
      return try {
        if (BuildConfig.SHIORI_ANDROID_DISTRIBUTION != "direct-apk") {
          return bridgeResult(ok = false, message = "android-direct-updater-disabled")
        }
        val request = AndroidApkUpdateRequest.fromJson(JSONObject(requestValue))
        thread(name = "shiori-direct-apk-update", isDaemon = true) {
          installDirectApkInBackground(request)
        }
        bridgeResult(ok = true, message = null)
      } catch (error: Exception) {
        bridgeResult(ok = false, message = error.message ?: "android-update-request-invalid")
      }
    }
  }

  private fun shareCachedExport(request: AndroidShareExportRequest) {
    val exportsDir = File(cacheDir, "exports")
    val exportFile = request.path?.let { File(it) }
      ?: File(exportsDir, sanitizeExportFilename(request.filename))
    val canonicalExportsDir = exportsDir.canonicalFile
    val canonicalExportFile = exportFile.canonicalFile
    if (!canonicalExportFile.path.startsWith("${canonicalExportsDir.path}${File.separator}")) {
      throw IllegalArgumentException("android-share-export-path-invalid")
    }
    if (!canonicalExportFile.isFile) {
      throw IllegalStateException("android-share-export-missing")
    }
    val exportUri = FileProvider.getUriForFile(
      this,
      "$packageName.fileprovider",
      canonicalExportFile,
    )
    val shareIntent = Intent(Intent.ACTION_SEND).apply {
      type = request.mime
      putExtra(Intent.EXTRA_STREAM, exportUri)
      putExtra(Intent.EXTRA_SUBJECT, request.filename)
      clipData = ClipData.newUri(contentResolver, request.filename, exportUri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    // Three-arg createChooser: the IntentSender fires when the user PICKS a
    // target — the chooser has no cancel callback, so "picked" is the only
    // success signal. FLAG_MUTABLE on S+ lets the system attach
    // EXTRA_CHOSEN_COMPONENT (we only need the firing itself).
    val chosenIntent = Intent(exportShareChosenAction).setPackage(packageName)
    val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
    val chosenPending = PendingIntent.getBroadcast(this, 0, chosenIntent, pendingFlags)
    val chooser = Intent.createChooser(shareIntent, request.title, chosenPending.intentSender)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    fun launchChooser(): Exception? = try {
      startActivity(chooser)
      null
    } catch (error: Exception) {
      error
    }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      launchChooser()?.let { throw it }
      return
    }
    val error = AtomicReference<Exception?>()
    val launched = CountDownLatch(1)
    runOnUiThread {
      error.set(launchChooser())
      launched.countDown()
    }
    try {
      launched.await()
    } catch (interrupted: InterruptedException) {
      Thread.currentThread().interrupt()
      throw interrupted
    }
    error.get()?.let { throw it }
  }

  private fun sanitizeExportFilename(filename: String): String {
    val clean = filename
      .substringAfterLast('/')
      .replace(Regex("[^A-Za-z0-9._ -]"), "_")
      .trim()
      .ifBlank { "Shiori-export.pdf" }
    if (clean.length <= 160) return clean
    val dot = clean.lastIndexOf(".").takeIf { it > 0 }
    val extension = dot?.let { clean.slice(it until clean.length).take(16) } ?: ""
    val stem = dot?.let { clean.take(it) } ?: clean
    return "${stem.take(160 - extension.length)}$extension"
  }

  private fun bridgeResult(ok: Boolean, message: String?): String {
    val json = JSONObject().put("ok", ok)
    if (!message.isNullOrBlank()) json.put("message", message)
    return json.toString()
  }
}

private data class AndroidShareExportRequest(
  val path: String?,
  val filename: String,
  val mime: String,
  val title: String,
) {
  companion object {
    fun fromJson(json: JSONObject): AndroidShareExportRequest {
      val filename = json.optString("filename").takeIf { it.isNotBlank() }
        ?: "Shiori-export.pdf"
      val path = json.optString("path").takeIf { it.isNotBlank() }
      val mime = json.optString("mime").takeIf { it.isNotBlank() }
        ?: "application/pdf"
      val title = json.optString("title").takeIf { it.isNotBlank() }
        ?: "Share PDF"
      return AndroidShareExportRequest(path = path, filename = filename, mime = mime, title = title)
    }
  }
}

private data class DocumentInfo(
  val name: String?,
  val size: Long?,
)

// CSS px (device px / density): what the page's safe-area variables take.
private data class SafeAreaInsets(
  val top: Float,
  val bottom: Float,
  val left: Float,
  val right: Float,
) {
  fun toJson(): JSONObject = JSONObject()
    .put("top", top.toDouble())
    .put("bottom", bottom.toDouble())
    .put("left", left.toDouble())
    .put("right", right.toDouble())
}

private data class DocumentOpenPayload(
  val uri: String,
  val name: String?,
  val size: Long?,
) {
  fun toJson(): JSONObject {
    val json = JSONObject()
      .put("uri", uri)
    if (!name.isNullOrBlank()) json.put("name", name)
    if (size != null && size >= 0) json.put("size", size)
    return json
  }
}
