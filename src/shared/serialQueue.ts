/**
 * Run async tasks one at a time, in call order.
 *
 * For operations that own a shared resource and cannot interleave. Two page
 * merges started in quick succession (paste an image twice) each claimed the
 * open generation, so the second immediately superseded the first — the first
 * abandoned itself and one of the two images silently never appeared.
 * Serialising is the right answer rather than rejecting the second: the
 * reader asked for both pages.
 *
 * Queueing also fixes what the second task sees. Each merge captures its
 * target document when it starts, so running them back to back means the
 * second captures the already-merged document instead of the pre-merge one it
 * would otherwise have raced against.
 *
 * A failing task does not stall the queue, and its rejection still reaches
 * its own caller — never a later one.
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    // Both handlers run `task`: a rejected predecessor must not skip it.
    const result = tail.then(task, task);
    // The queue follows the settled result, swallowing the rejection so it is
    // delivered once — to `result`'s caller — and not re-thrown into the next
    // task's chain.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
