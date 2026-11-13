package `fun`.nagi.shiori

import org.json.JSONObject

/**
 * Documents handed to Shiori (VIEW / SEND intents) that the page has not
 * drained yet through the ShioriAndroid bridge.
 *
 * Touched from the main thread (onCreate / onNewIntent enqueue) and the
 * WebView JavaBridge thread (drain), so every access holds this queue's one
 * lock. One instance lives for the process (see [PendingDocumentOpens]): an
 * Activity recreated before its page drained the queue used to take the
 * queue down with it, and the requested document never opened.
 */
internal class PendingDocumentOpenQueue {
  private val lock = Any()
  private val pending = mutableListOf<DocumentOpenPayload>()

  /** Adds each payload whose URI is not already waiting, in order. */
  fun enqueue(payloads: List<DocumentOpenPayload>) {
    synchronized(lock) {
      payloads.forEach { payload ->
        if (pending.none { it.uri == payload.uri }) pending.add(payload)
      }
    }
  }

  /**
   * Copy-and-clear atomically so an enqueue between the two steps can
   * neither be wiped undelivered nor mutate the list mid-iteration.
   */
  fun drain(): List<DocumentOpenPayload> = synchronized(lock) {
    val drained = pending.toList()
    pending.clear()
    drained
  }

  fun hasPending(): Boolean = synchronized(lock) { pending.isNotEmpty() }

  fun clear() {
    synchronized(lock) { pending.clear() }
  }
}

/**
 * The process's queue. In memory on purpose: process death takes it along,
 * which is right, since the URI grants that came with the intents die too.
 */
internal object PendingDocumentOpens {
  val queue = PendingDocumentOpenQueue()
}

/**
 * Whether onCreate is seeing the task's original VIEW/SEND intent again
 * rather than a new request: a recreated Activity (configuration change or
 * process death) gets its saved state back, and a relaunch from Recents is
 * flagged as launched from history. Either way the intent must not be
 * enqueued again — after a recreation its payload is still in the process
 * queue, and after process death or from Recents its URI grant is usually
 * gone. A real new request arrives through onNewIntent and always enqueues.
 */
internal fun isReplayedLaunch(hasSavedState: Boolean, launchedFromHistory: Boolean): Boolean =
  hasSavedState || launchedFromHistory

internal data class DocumentOpenPayload(
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
