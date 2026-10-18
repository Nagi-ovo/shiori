/**
 * What a merge captured about its target when it started.
 *
 * `model` is the document model object the merge read its overlays from. The
 * store replaces that object on every commit (see store.commit), so holding
 * the reference is a revision check: if it still matches, nobody edited the
 * document while the merge ran. Matching generation / tab / hash is not
 * enough — adding or deleting an annotation on the same tab changes none of
 * those, and committing would write the merge's stale overlay snapshot back
 * over the reader's newer edits.
 */
export type MergeTargetClaim<TModel> = {
  generation: number;
  tabId: string | null;
  documentHash: string | null;
  model: TModel;
};

/**
 * One consistent snapshot of what a merge operates on, plus the claim that
 * guards it.
 *
 * The point is that `claim.model` and the `model` the merge actually reads
 * are the same object by construction. Taking the claim from the live store
 * while the merge body read a React closure meant the guard compared the
 * current model against itself and let through a merge assembled from an
 * older one — the exact overwrite the guard exists to prevent. Callers must
 * read every page and overlay from the returned snapshot, never from a
 * closure.
 */
export function captureMergeTarget<TOpened, TModel>(sources: {
  /** The live editor store. */
  snapshot: () => { opened: TOpened; model: TModel };
  /**
   * The navigation generation current when the reader acted. A VALUE, and a
   * value the merge does NOT claim: taking a fresh generation at execution
   * time let a queued merge outrank an open the reader had started in the
   * meantime, so the newly opened document abandoned itself while the older
   * paste committed. Ordering between merges is the queue's job; this number
   * only answers "has anything superseded me since the reader asked".
   */
  generation: number;
  /**
   * The tab the reader made the request against. A VALUE, not a getter, and
   * deliberately so: it is an intent, fixed when they acted. Re-reading the
   * active tab at execution time meant a queued second paste retargeted
   * itself at whatever document the reader had since switched to — the page
   * landed in the wrong file and reported success.
   */
  tabId: string | null;
  tabHash: (tabId: string) => string | null;
}): {
  opened: TOpened;
  model: TModel;
  claim: MergeTargetClaim<TModel>;
} {
  // Everything except the tab is read here, at execution time. Merges are
  // queued, so a second one runs long after the first changed the document:
  // a hash captured at enqueue time would describe the pre-merge state while
  // the store snapshot describes the post-merge one, and the claim would fail
  // its own ownership check. The tab is the exception — see tabId above.
  const { tabId } = sources;
  const { opened, model } = sources.snapshot();
  return {
    opened,
    model,
    claim: {
      generation: sources.generation,
      tabId,
      documentHash: tabId ? sources.tabHash(tabId) : null,
      model,
    },
  };
}

/** The same facts, read back at the moment the merge wants to commit. */
export type MergeWorld<TModel> = {
  generation: number;
  activeTabId: string | null;
  /** The target tab as it exists now, or undefined if it is gone. */
  targetTab: { hash?: string | null } | undefined;
  model: TModel;
};

/**
 * Whether a finished merge may still be applied.
 *
 * Exported so production and tests share one predicate. When the test file
 * reimplemented this, the suite stayed green even if the app had passed
 * `() => true`, which is precisely the bug the tests were supposed to catch.
 */
export function mergeStillOwnsTarget<TModel>(
  expected: MergeTargetClaim<TModel>,
  actual: MergeWorld<TModel>,
): boolean {
  if (!expected.tabId) return false;
  // A newer open or a tab switch claimed the generation.
  if (expected.generation !== actual.generation) return false;
  // The reader is looking at something else.
  if (expected.tabId !== actual.activeTabId) return false;
  // The tab was closed.
  if (!actual.targetTab) return false;
  // Reloaded or replaced: the bytes we merged against are not what it holds.
  if ((actual.targetTab.hash ?? null) !== expected.documentHash) return false;
  // Edited while the merge ran.
  if (expected.model !== actual.model) return false;
  return true;
}

/**
 * The commit/abandon decision for an in-app PDF page merge.
 *
 * A merge (pasting an image, appending a PDF) runs a long chain of awaits:
 * flush, export the base, append bytes, hash, load with pdfjs, walk every
 * page, import annotations, write the workspace cache. The reader can switch
 * to another tab at any point in that chain. Committing anyway would replace
 * the globally shared PDF store — that is, whatever document is on screen now
 * — with the result of a merge that belongs to a tab they have left.
 *
 * Committing is therefore conditional on still owning the target, and the
 * abandoned path has to give back everything the merge allocated: the pdfjs
 * document (its worker, byte buffer, and decoded page caches) and the
 * workspace cache row, which nothing references yet.
 *
 * Split out of App.tsx so the decision and its cleanup can be tested against
 * a deliberately delayed merge; the component itself has no test harness.
 */
export async function finishPdfMerge<TDoc>({
  stillOwnsTarget,
  document,
  cacheId,
  commit,
  destroyDocument,
  removeCachedSource,
}: {
  /** Re-checked at the last possible moment, never cached. */
  stillOwnsTarget: () => boolean;
  document: TDoc;
  /** Workspace cache row written for the merged bytes, if it got that far. */
  cacheId: string | null;
  /** Applies the merge. Only ever called while the target is still owned. */
  commit: () => void;
  destroyDocument: (document: TDoc) => void;
  removeCachedSource: (cacheId: string) => Promise<void>;
}): Promise<boolean> {
  if (stillOwnsTarget()) {
    commit();
    return true;
  }
  // Order matters only in that both must run: a failure to drop the cache row
  // must not leak the pdfjs document, which holds a worker.
  destroyDocument(document);
  if (cacheId) {
    await removeCachedSource(cacheId).catch(() => undefined);
  }
  return false;
}

/**
 * Bind a merge to the reader's intent, and return the executor.
 *
 * Two phases, and the split is the whole point. Phase one runs
 * synchronously while the reader's action is still on the stack and captures
 * WHAT THEY MEANT: which tab, and which navigation generation was current.
 * Phase two — decoding an image, waiting behind other merges in the queue —
 * can take arbitrarily long, and re-reading either value then would let the
 * merge retarget itself at whatever the reader has since moved to.
 *
 * The generation is READ, never claimed. A merge that took a fresh one would
 * outrank an open the reader started while it queued: the new document would
 * fail its own check and abandon itself while the older paste committed.
 * Ordering between merges is the queue's job, not the generation's.
 *
 * Extracted so both properties are testable without mounting the app.
 */
export function bindPageMergeIntent<TArgs extends unknown[], TResult>(read: {
  activeTabId: () => string | null;
  generation: () => number;
  enqueue: (task: () => Promise<TResult>) => Promise<TResult>;
  run: (
    intent: { tabId: string | null; generation: number },
    ...args: TArgs
  ) => Promise<TResult>;
}): (...args: TArgs) => Promise<TResult> {
  const intent = {
    tabId: read.activeTabId(),
    generation: read.generation(),
  };
  return (...args: TArgs) => read.enqueue(() => read.run(intent, ...args));
}
