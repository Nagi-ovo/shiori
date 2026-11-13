package `fun`.nagi.shiori

import java.util.Collections
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The pending-open queue across the Activity lifecycle. MainActivity cannot
 * be instantiated in a JVM test, so [Instance] replays what its onCreate /
 * onNewIntent / bridge drain do with the real queue and the real replay rule.
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

    fun drain() = queue.drain()
  }

  @Before
  fun reset() {
    PendingDocumentOpens.queue.clear()
  }

  @Test
  fun drainsWhatWasEnqueuedInOrderWithItsDetails() {
    val queue = PendingDocumentOpenQueue()
    queue.enqueue(listOf(a, b))

    assertTrue(queue.hasPending())
    assertEquals(listOf(a, b), queue.drain())
    assertFalse(queue.hasPending())
    assertEquals(emptyList<DocumentOpenPayload>(), queue.drain())
  }

  @Test
  fun aUriAlreadyWaitingIsNotQueuedTwice() {
    val queue = PendingDocumentOpenQueue()
    queue.enqueue(listOf(a))
    queue.enqueue(listOf(a.copy(name = "renamed.pdf"), b))

    assertEquals(listOf(a, b), queue.drain())
  }

  @Test
  fun theSameFileOpenedAgainAfterADrainIsQueuedAgain() {
    val queue = PendingDocumentOpenQueue()
    queue.enqueue(listOf(a))
    queue.drain()
    queue.enqueue(listOf(a))

    assertEquals(listOf(a), queue.drain())
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
    assertEquals(listOf(a), recreated.drain())
    assertFalse(PendingDocumentOpens.queue.hasPending())
  }

  @Test
  fun aNewIntentAfterRecreationStillOpens() {
    Instance(PendingDocumentOpens.queue, false, false, listOf(a))
    val recreated = Instance(PendingDocumentOpens.queue, true, false, listOf(a))
    recreated.drain()

    recreated.onNewIntent(listOf(b))

    assertEquals(listOf(b), recreated.drain())
  }

  @Test
  fun aNewIntentIsNeverTreatedAsAReplay() {
    val live = Instance(PendingDocumentOpens.queue, false, false, emptyList())
    live.onNewIntent(listOf(a))
    live.drain()

    live.onNewIntent(listOf(a)) // the reader opens the same file again

    assertEquals(listOf(a), live.drain())
  }

  @Test
  fun aRelaunchFromRecentsDoesNotReopenTheOriginalIntent() {
    val relaunched = Instance(PendingDocumentOpenQueue(), false, true, listOf(a))

    assertEquals(emptyList<DocumentOpenPayload>(), relaunched.drain())
  }

  @Test
  fun afterProcessDeathTheStaleIntentIsNotReopened() {
    // A new process starts with an empty queue; the restored Activity has
    // saved state and the original intent, whose grant is gone.
    val restored = Instance(PendingDocumentOpenQueue(), true, false, listOf(a))

    assertEquals(emptyList<DocumentOpenPayload>(), restored.drain())
  }

  @Test
  fun enqueueOnOneThreadAndDrainOnAnotherLosesAndRepeatsNothing() {
    val queue = PendingDocumentOpenQueue()
    val count = 2_000
    val drained = Collections.synchronizedList(mutableListOf<DocumentOpenPayload>())
    val start = CountDownLatch(1)
    val enqueuer = thread {
      start.await()
      for (i in 0 until count) {
        queue.enqueue(listOf(DocumentOpenPayload("content://files/$i.pdf", null, null)))
      }
    }
    val drainer = thread {
      start.await()
      while (enqueuer.isAlive) drained.addAll(queue.drain())
    }
    start.countDown()
    enqueuer.join()
    drainer.join()
    drained.addAll(queue.drain())

    assertEquals((0 until count).map { "content://files/$it.pdf" }, drained.map { it.uri })
  }
}
