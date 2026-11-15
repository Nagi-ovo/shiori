package `fun`.nagi.shiori

import org.json.JSONObject

/**
 * Documents handed to Shiori (VIEW / SEND intents) that the page has not
 * acknowledged yet through the ShioriAndroid bridge.
 *
 * Touched from the main thread (onCreate / onNewIntent enqueue) and the
 * WebView JavaBridge thread (drain, ack), so every access holds this queue's
 * one lock. One instance lives for the process (see [PendingDocumentOpens]):
 * an Activity recreated before its page drained the queue used to take the
 * queue down with it, and the requested document never opened.
 *
 * Drain does not remove: an item stays until the page acks its delivery id,
 * so a page that reloads (or a WebView that goes away) between draining and
 * starting the open gets the item again from the next drain. The page dedupes
 * re-deliveries within one session by the same id.
 */
internal class PendingDocumentOpenQueue {
  private val lock = Any()
  private val pending = mutableListOf<PendingDocumentOpen>()
  private var nextDeliveryId = 1L

  /**
   * Adds one delivery (one intent): each payload gets its own delivery id,
   * so the same URI sent again by a later intent is a new open, not a
   * duplicate of the one still waiting — a sender may reuse one fixed
   * content:// URI for different files. A URI listed twice within the same
   * delivery is one open.
   */
  fun enqueue(payloads: List<DocumentOpenPayload>) {
    synchronized(lock) {
      payloads.distinctBy { it.uri }.forEach { payload ->
        pending.add(PendingDocumentOpen((nextDeliveryId++).toString(), payload))
      }
    }
  }

  /** Every un-acked delivery, in order, each once per call. */
  fun drain(): List<PendingDocumentOpen> = synchronized(lock) { pending.toList() }

  /** The page has started opening these deliveries; never deliver them again. */
  fun ack(deliveryIds: Collection<String>) {
    synchronized(lock) { pending.removeAll { it.deliveryId in deliveryIds } }
  }

  fun hasPending(): Boolean = synchronized(lock) { pending.isNotEmpty() }

  fun clear() {
    synchronized(lock) { pending.clear() }
  }
}

internal data class PendingDocumentOpen(
  val deliveryId: String,
  val payload: DocumentOpenPayload,
) {
  fun toJson(): JSONObject = payload.toJson().put("deliveryId", deliveryId)
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
