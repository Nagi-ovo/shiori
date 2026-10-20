package `fun`.nagi.shiori

import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

// A share that carries text instead of a file (a link from Chrome, a text
// selection) arrives as SEND with EXTRA_TEXT and no EXTRA_STREAM. Shiori is
// in the share sheet for text/plain because .md files are often typed that
// way, so it keeps the share and opens the text as a Markdown document: the
// text is written to cache/shares/ and handed to the frontend through the
// app's own FileProvider, like any other shared file.

private const val SHARES_DIR = "shares"
private const val SHARE_MAX_AGE_MS = 24L * 60 * 60 * 1000

internal fun MainActivity.sharedTextDocumentUri(intent: Intent): Uri? {
  val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
    ?.takeIf { it.isNotBlank() } ?: return null
  val subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()
  return try {
    val sharesDir = File(cacheDir, SHARES_DIR)
    val now = System.currentTimeMillis()
    // Each share gets its own folder so the file keeps a readable name;
    // folders from earlier days have long been read.
    sharesDir.listFiles()?.forEach { old ->
      if (now - old.lastModified() > SHARE_MAX_AGE_MS) old.deleteRecursively()
    }
    val dir = File(sharesDir, now.toString())
    dir.mkdirs()
    val file = File(dir, "${sharedTextFileStem(subject, text) ?: now.toString()}.md")
    file.writeText(text)
    FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
  } catch (_: Exception) {
    null
  }
}

// The tab title: the share's subject (Chrome sends the page title) or the
// text's first line, cut to a file-name-safe length.
private fun sharedTextFileStem(subject: String?, text: String): String? {
  val source = subject?.takeIf { it.isNotBlank() }
    ?: text.lineSequence().firstOrNull { it.isNotBlank() }
    ?: return null
  return source
    .replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), " ")
    .replace(Regex("\\s+"), " ")
    .trim()
    .trimStart('.')
    .take(80)
    .trim()
    .takeIf { it.isNotBlank() }
}
