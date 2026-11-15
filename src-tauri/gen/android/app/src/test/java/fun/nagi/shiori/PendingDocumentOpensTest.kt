package `fun`.nagi.shiori

import java.util.Collections
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The pending-open queue across the Activity lifecycle. MainActivity cannot
 * be instantiated in a JVM test, so [Instance] replays what its onCreate /
 * onNewIntent / bridge drain + ack do with the real queue and the real
 * replay rule.
 */
class PendingDocumentOpensTest {
  private val a = DocumentOpenPayload("content://files/a.pdf", "a.pdf", 4)
  private val b = DocumentOpenPayload("content://files/b.pdf", "b.pdf", null)

  /** One MainActivity instance, as far as document intake goes. */
  private class Instance(
    private val queue: PendingDocumentOpenQueue,
    hasSavedState: Boolean,
    launchedFromHistory: Boolean,
    launchIntent: List<DocumentOpenPayload>,
  ) {
    init {
      if (!isReplayedLaunch(hasSavedState, launchedFromHistory)) queue.enqueue(launchIntent)
    }

    fun onNewIntent(payloads: List<DocumentOpenPayload>) = queue.enqueue(payloads)

    /** A page that drains and starts opening everything it got. */
    fun drainAndAck(): List<DocumentOpenPayload> {
      val drained = queue.drain()
      queue.ack(drained.map { it.deliveryId })
      return drained.map { it.payload }
    }
  }

  private fun PendingDocumentOpenQueue.drainPayloads() = drain().map { it.payload }

  @Before
  fun reset() {
    PendingDocumentOpens.queue.clear()
  }

  @Test
  fun drainsWhatWasEnqueuedInOrderWithItsDetails() {
    val queue = PendingDocumentOpenQueue()
    queue.enqueue(listOf(a, b))

    assertTrue(queue.hasPending())
    assertEquals(listOf(a, b), queue.drainPayloads())
  }

  @Test
  fun aDrainWithoutAckIsDeliveredAgainByTheNextDrain() {
    // The page drained, then reloaded before it started opening.
    val queue = PendingDocumentOpenQueue()
    queue.enqueue(listOf(a, b))

    val first = queue.drain()
    val reloaded = queue.drain()

    assertEquals(first, reloaded)
    assertEquals(listOf(a, b), reloaded.map { it.payload })
    assertTrue(queue.hasPending())
  }

  @Test
  fun anAckedDeliveryIsNeverDeliveredAgain() {
    val queue = PendingDocumentOpenQueue()
    queue.enqueue(listOf(a))
    queue.ack(queue.drain().map { it.deliveryId })

    assertEquals(emptyList<PendingDocumentOpen>(), queue.drain())
    assertFalse(queue.hasPending())
  }

  @Test
  fun ackingOneDeliveryLeavesTheOthers() {
    val queue = PendingDocumentOpenQueue()
    queue.enqueue(listOf(a, b))
    val (first, second) = queue.drain()

    queue.ack(listOf(first.deliveryId))

    assertEquals(listOf(second), queue.drain())
  }

  @Test
  fun anAckForAnUnknownIdChangesNothing() {
    val queue = PendingDocumentOpenQueue()
    queue.enqueue(listOf(a))
    val drained = queue.drain()

    queue.ack(listOf("not-a-delivery"))

    assertEquals(drained, queue.drain())
  }

  @Test
  fun theSameUriFromASecondIntentIsASecondDelivery() {
    // A sender reusing one fixed content:// URI for different files, or the
    // reader sending the same file twice: both intents must open.
    val other = a.copy(name = "other.pdf", size = 9)
    val queue = PendingDocumentOpenQueue()
    queue.enqueue(listOf(a))
    queue.enqueue(listOf(other))

    val drained = queue.drain()

    assertEquals(listOf(a, other), drained.map { it.payload })
    assertNotEquals(drained[0].deliveryId, drained[1].deliveryId)
  }

  @Test
  fun aUriListedTwiceInOneDeliveryIsQueuedOnce() {
    val queue = PendingDocumentOpenQueue()
    queue.enqueue(listOf(a, b, a.copy(name = "dup.pdf")))

    assertEquals(listOf(a, b), queue.drainPayloads())
  }

  @Test
  fun theSameFileOpenedAgainAfterAnAckIsQueuedAgain() {
    val queue = PendingDocumentOpenQueue()
    queue.enqueue(listOf(a))
    queue.ack(queue.drain().map { it.deliveryId })
    queue.enqueue(listOf(a))

    assertEquals(listOf(a), queue.drainPayloads())
  }

  @Test
  fun theJsonCarriesTheDeliveryIdAndDetails() {
    val queue = PendingDocumentOpenQueue()
    queue.enqueue(listOf(a, b))
    val (first, second) = queue.drain()

    val json = first.toJson()
    assertEquals(a.uri, json.getString("uri"))
    assertEquals("a.pdf", json.getString("name"))
    assertEquals(4L, json.getLong("size"))
    assertEquals(first.deliveryId, json.getString("deliveryId"))
    val bare = second.toJson()
    assertFalse(bare.has("size"))
    assertEquals(second.deliveryId, bare.getString("deliveryId"))
    // documentInfo answers with the payload alone, no delivery id.
    assertFalse(a.toJson().has("deliveryId"))
  }

  @Test
  fun clearDropsUnackedDeliveries() {
    // MainActivity.onDestroy when the Activity finishes for good: grants
    // for anything still waiting leave with the task.
    val queue = PendingDocumentOpenQueue()
    queue.enqueue(listOf(a, b))
    queue.drain()

    queue.clear()

    assertFalse(queue.hasPending())
    assertEquals(emptyList<PendingDocumentOpen>(), queue.drain())
  }

  @Test
  fun anOpenSurvivesRecreationBeforeThePageDrainsIt() {
    // "Open with" cold-starts the app; a configuration change the manifest
    // does not handle (font scale, density) recreates the Activity before
    // its WebView drained the queue.
    Instance(PendingDocumentOpens.queue, false, false, listOf(a))
    val recreated = Instance(PendingDocumentOpens.queue, true, false, listOf(a))

    // Delivered once: kept by the process queue, not re-enqueued from the
    // replayed launch intent.
    assertEquals(listOf(a), recreated.drainAndAck())
    assertFalse(PendingDocumentOpens.queue.hasPending())
  }

  @Test
  fun anOpenDrainedButNotAckedSurvivesRecreation() {
    // The old page drained, then its WebView went away with the Activity
    // before it started the open.
    Instance(PendingDocumentOpens.queue, false, false, listOf(a))
    PendingDocumentOpens.queue.drain()
    val recreated = Instance(PendingDocumentOpens.queue, true, false, listOf(a))

    assertEquals(listOf(a), recreated.drainAndAck())
    assertEquals(emptyList<DocumentOpenPayload>(), recreated.drainAndAck())
  }

  @Test
  fun aNewIntentAfterRecreationStillOpens() {
    Instance(PendingDocumentOpens.queue, false, false, listOf(a))
    val recreated = Instance(PendingDocumentOpens.queue, true, false, listOf(a))
    recreated.drainAndAck()

    recreated.onNewIntent(listOf(b))

    assertEquals(listOf(b), recreated.drainAndAck())
  }

  @Test
  fun aNewIntentIsNeverTreatedAsAReplay() {
    val live = Instance(PendingDocumentOpens.queue, false, false, emptyList())
    live.onNewIntent(listOf(a))
    live.drainAndAck()

    live.onNewIntent(listOf(a)) // the reader opens the same file again

    assertEquals(listOf(a), live.drainAndAck())
  }

  @Test
  fun aSecondIntentForAUriStillWaitingIsKept() {
    val live = Instance(PendingDocumentOpens.queue, false, false, listOf(a))

    live.onNewIntent(listOf(a)) // before the page drained the first

    assertEquals(listOf(a, a), live.drainAndAck())
  }

  @Test
  fun aRelaunchFromRecentsDoesNotReopenTheOriginalIntent() {
    val relaunched = Instance(PendingDocumentOpenQueue(), false, true, listOf(a))

    assertEquals(emptyList<DocumentOpenPayload>(), relaunched.drainAndAck())
  }

  @Test
  fun afterProcessDeathTheStaleIntentIsNotReopened() {
    // A new process starts with an empty queue; the restored Activity has
    // saved state and the original intent, whose grant is gone.
    val restored = Instance(PendingDocumentOpenQueue(), true, false, listOf(a))

    assertEquals(emptyList<DocumentOpenPayload>(), restored.drainAndAck())
  }

  @Test
  fun enqueueOnOneThreadAndDrainAckOnAnotherLosesAndRepeatsNothing() {
    val queue = PendingDocumentOpenQueue()
    val count = 2_000
    val drained = Collections.synchronizedList(mutableListOf<PendingDocumentOpen>())
    val start = CountDownLatch(1)
    // Single drainer, acking each batch before the next drain, as the page
    // does once it has started the opens.
    fun drainAndAck() {
      val batch = queue.drain()
      queue.ack(batch.map { it.deliveryId })
      drained.addAll(batch)
    }
    val enqueuer = thread {
      start.await()
      for (i in 0 until count) {
        queue.enqueue(listOf(DocumentOpenPayload("content://files/$i.pdf", null, null)))
      }
    }
    val drainer = thread {
      start.await()
      while (enqueuer.isAlive) drainAndAck()
    }
    start.countDown()
    enqueuer.join()
    drainer.join()
    drainAndAck()

    assertEquals((0 until count).map { "content://files/$it.pdf" }, drained.map { it.payload.uri })
    assertEquals(count, drained.map { it.deliveryId }.toSet().size)
    assertFalse(queue.hasPending())
  }
}
