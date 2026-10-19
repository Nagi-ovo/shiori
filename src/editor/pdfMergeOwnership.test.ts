import { describe, expect, test } from "bun:test";
import { createSerialQueue } from "../shared/serialQueue";
import {
  bindPageMergeIntent,
  captureMergeTarget,
  finishPdfMerge,
  mergeStillOwnsTarget,
} from "./pdfMergeOwnership";

type FakeDoc = { id: string; destroyed: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type FakeModel = { overlays: string[] };

/**
 * Stands in for the parts of App.tsx a merge would touch: which tab is on
 * screen, what each tab holds, the document model, and the single shared PDF
 * store.
 *
 * The ownership decision itself is NOT reimplemented here — it calls the same
 * mergeStillOwnsTarget the app calls. An earlier version of this file had its
 * own copy, so the suite stayed green no matter what predicate the app
 * actually used.
 */
function harness() {
  const initialModel: FakeModel = { overlays: ["note-1"] };
  const state = {
    activeTabId: "A" as string | null,
    generation: 7,
    tabs: [
      { id: "A", hash: "hash-a" },
      { id: "C", hash: "hash-c" },
    ] as { id: string; hash: string }[],
    model: initialModel,
    store: "document-a",
    committedTo: null as string | null,
    removedCacheIds: [] as string[],
  };
  const claim = {
    generation: state.generation,
    tabId: "A" as string | null,
    documentHash: "hash-a" as string | null,
    model: initialModel,
  };
  const stillOwnsTarget = () =>
    mergeStillOwnsTarget(claim, {
      generation: state.generation,
      activeTabId: state.activeTabId,
      targetTab: state.tabs.find((tab) => tab.id === claim.tabId),
      model: state.model,
    });
  return { state, stillOwnsTarget };
}

describe("finishPdfMerge", () => {
  test("commits when the target is still on screen", async () => {
    const { state, stillOwnsTarget } = harness();
    const doc: FakeDoc = { id: "merged", destroyed: false };

    const committed = await finishPdfMerge({
      stillOwnsTarget,
      document: doc,
      cacheId: "cache-merged",
      commit: () => {
        state.store = "document-a+merged";
        state.committedTo = "A";
      },
      destroyDocument: (value) => {
        value.destroyed = true;
      },
      removeCachedSource: async (id) => {
        state.removedCacheIds.push(id);
      },
    });

    expect(committed).toBe(true);
    expect(state.store).toBe("document-a+merged");
    expect(doc.destroyed).toBe(false);
    expect(state.removedCacheIds).toEqual([]);
  });

  test("abandons the merge when the reader switched tabs while it ran", async () => {
    // The scenario: a merge starts on A, the reader switches to C before it
    // finishes. Committing would drop A's merged document into the shared
    // store that C is currently showing.
    const { state, stillOwnsTarget } = harness();
    const doc: FakeDoc = { id: "merged", destroyed: false };
    const slowStep = deferred<void>();

    const merge = (async () => {
      await slowStep.promise;
      return finishPdfMerge({
        stillOwnsTarget,
        document: doc,
        cacheId: "cache-merged",
        commit: () => {
          state.store = "document-a+merged";
          state.committedTo = "A";
        },
        destroyDocument: (value) => {
          value.destroyed = true;
        },
        removeCachedSource: async (id) => {
          state.removedCacheIds.push(id);
        },
      });
    })();

    // Reader moves to C mid-merge, exactly as activateLoadedTab would.
    state.activeTabId = "C";
    state.generation += 1;
    state.store = "document-c";
    slowStep.resolve();

    expect(await merge).toBe(false);
    // C is untouched.
    expect(state.store).toBe("document-c");
    // A was never committed to.
    expect(state.committedTo).toBeNull();
    expect(state.tabs.find((tab) => tab.id === "A")?.hash).toBe("hash-a");
    // Temporary resources released.
    expect(doc.destroyed).toBe(true);
    expect(state.removedCacheIds).toEqual(["cache-merged"]);
  });

  test("abandons when the reader edited the same document mid-merge", async () => {
    // Same tab, same generation, same bytes on disk — only the model changed.
    // Committing here would write the merge's stale overlay snapshot back
    // over the annotation the reader just added.
    const { state, stillOwnsTarget } = harness();
    const doc: FakeDoc = { id: "merged", destroyed: false };
    const slowStep = deferred<void>();

    const merge = (async () => {
      await slowStep.promise;
      return finishPdfMerge({
        stillOwnsTarget,
        document: doc,
        cacheId: "cache-merged",
        commit: () => {
          state.committedTo = "A";
          state.model = { overlays: ["note-1"] };
        },
        destroyDocument: (value) => {
          value.destroyed = true;
        },
        removeCachedSource: async (id) => {
          state.removedCacheIds.push(id);
        },
      });
    })();

    // The reader adds an annotation. store.commit replaces the model object.
    state.model = { overlays: ["note-1", "note-2"] };
    slowStep.resolve();

    expect(await merge).toBe(false);
    expect(state.committedTo).toBeNull();
    expect(state.model.overlays).toEqual(["note-1", "note-2"]);
    expect(doc.destroyed).toBe(true);
    expect(state.removedCacheIds).toEqual(["cache-merged"]);
  });

  test("abandons when the target tab was reloaded under the merge", async () => {
    const { state, stillOwnsTarget } = harness();
    const doc: FakeDoc = { id: "merged", destroyed: false };
    // Same tab, still active, but its bytes are no longer what we merged.
    state.tabs = [{ id: "A", hash: "hash-a-reloaded" }];

    const committed = await finishPdfMerge({
      stillOwnsTarget,
      document: doc,
      cacheId: "cache-merged",
      commit: () => {
        state.committedTo = "A";
      },
      destroyDocument: (value) => {
        value.destroyed = true;
      },
      removeCachedSource: async (id) => {
        state.removedCacheIds.push(id);
      },
    });

    expect(committed).toBe(false);
    expect(state.committedTo).toBeNull();
    expect(doc.destroyed).toBe(true);
    expect(state.removedCacheIds).toEqual(["cache-merged"]);
  });

  test("still releases the document when dropping the cache row fails", async () => {
    const { state, stillOwnsTarget } = harness();
    const doc: FakeDoc = { id: "merged", destroyed: false };
    state.activeTabId = "C";

    const committed = await finishPdfMerge({
      stillOwnsTarget,
      document: doc,
      cacheId: "cache-merged",
      commit: () => {
        state.committedTo = "A";
      },
      destroyDocument: (value) => {
        value.destroyed = true;
      },
      removeCachedSource: async () => {
        throw new Error("indexeddb unavailable");
      },
    });

    expect(committed).toBe(false);
    // A cache row that outlives its merge is reclaimable; a leaked document
    // holds the engine's memory for the rest of the session.
    expect(doc.destroyed).toBe(true);
  });
});

describe("mergeStillOwnsTarget", () => {
  const model = { overlays: ["a"] };
  const claim = {
    generation: 3,
    tabId: "A" as string | null,
    documentHash: "hash-a" as string | null,
    model,
  };
  const world = {
    generation: 3,
    activeTabId: "A" as string | null,
    targetTab: { hash: "hash-a" } as { hash?: string | null } | undefined,
    model,
  };

  test("holds when nothing moved", () => {
    expect(mergeStillOwnsTarget(claim, world)).toBe(true);
  });

  test("fails on every way the target can be lost", () => {
    // Each case changes exactly one fact, so a predicate that dropped any one
    // of these checks fails here rather than passing by coincidence.
    expect(mergeStillOwnsTarget(claim, { ...world, generation: 4 })).toBe(false);
    expect(mergeStillOwnsTarget(claim, { ...world, activeTabId: "C" })).toBe(
      false,
    );
    expect(mergeStillOwnsTarget(claim, { ...world, targetTab: undefined })).toBe(
      false,
    );
    expect(
      mergeStillOwnsTarget(claim, { ...world, targetTab: { hash: "other" } }),
    ).toBe(false);
    expect(
      mergeStillOwnsTarget(claim, { ...world, model: { overlays: ["a"] } }),
    ).toBe(false);
    expect(mergeStillOwnsTarget({ ...claim, tabId: null }, world)).toBe(false);
  });
});

describe("captureMergeTarget", () => {
  function world() {
    return {
      generation: 4,
      activeTabId: "A" as string | null,
      tabs: [{ id: "A", hash: "hash-a" }] as { id: string; hash: string }[],
      store: { opened: { bytes: "pdf" }, model: { overlays: ["a"] } },
    };
  }
  const sourcesFor = (
    state: ReturnType<typeof world>,
    tabId: string | null = state.activeTabId,
  ) => ({
    snapshot: () => state.store,
    generation: state.generation,
    tabId,
    tabHash: (candidate: string) =>
      state.tabs.find((tab) => tab.id === candidate)?.hash ?? null,
  });

  test("claims the very model it hands back for the merge to read", () => {
    // The wiring bug this guards: the claim was taken from the live store
    // while the merge body read a stale React closure, so the guard compared
    // the current model against itself and permitted a merge built from an
    // older one. Same object or the guard is meaningless.
    const state = world();
    const target = captureMergeTarget(sourcesFor(state));

    expect(target.model).toBe(state.store.model);
    expect(target.claim.model).toBe(target.model);
    expect(target.opened).toBe(state.store.opened);
    expect(target.claim).toMatchObject({
      generation: 4,
      tabId: "A",
      documentHash: "hash-a",
    });
  });

  test("reads the mutable fields at call time, not before", () => {
    // Generation, hash and store are getters precisely so a queued merge
    // cannot claim values that were current when it was enqueued.
    const state = world();
    state.activeTabId = "B";
    state.tabs = [{ id: "B", hash: "hash-b" }];
    state.generation = 9;
    state.store = { opened: { bytes: "other" }, model: { overlays: ["b"] } };

    const target = captureMergeTarget(sourcesFor(state));

    expect(target.claim).toMatchObject({
      generation: 9,
      tabId: "B",
      documentHash: "hash-b",
    });
    expect(target.model).toBe(state.store.model);
  });

  test("a later store edit does not retroactively satisfy the claim", () => {
    const state = world();
    const target = captureMergeTarget(sourcesFor(state));
    // store.commit replaces the model object.
    state.store = { opened: state.store.opened, model: { overlays: ["a", "b"] } };

    expect(
      mergeStillOwnsTarget(target.claim, {
        generation: target.claim.generation,
        activeTabId: "A",
        targetTab: { hash: "hash-a" },
        model: state.store.model,
      }),
    ).toBe(false);
  });

  test("a queued merge never retargets the tab the reader switched to", async () => {
    // Two pastes on A. The reader switches to B while the first runs. The
    // first correctly abandons — but the second must not then resolve its
    // target to B and drop A's page into B, reporting success. The tab is
    // bound when the reader acts; only the mutable state is read late.
    const state = world();
    state.tabs = [
      { id: "A", hash: "hash-a" },
      { id: "B", hash: "hash-b" },
    ];
    const enqueue = createSerialQueue();
    const committedTo: (string | null)[] = [];

    const merge = () => {
      // Phase 1: runs while the reader's action is still on the stack.
      const requestedTabId = state.activeTabId;
      return enqueue(async () => {
        const target = captureMergeTarget(sourcesFor(state, requestedTabId));
        await Promise.resolve();
        const owns = mergeStillOwnsTarget(target.claim, {
          generation: state.generation,
          activeTabId: state.activeTabId,
          targetTab: state.tabs.find((tab) => tab.id === target.claim.tabId),
          model: state.store.model,
        });
        if (owns) committedTo.push(target.claim.tabId);
        return owns;
      });
    };

    const first = merge();
    const second = merge();
    // The reader moves to B while the first merge is in flight.
    state.activeTabId = "B";
    state.generation += 1;
    state.store = { opened: { bytes: "b" }, model: { overlays: ["b"] } };

    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(committedTo).toEqual([]);
  });

  test("a queued second merge claims the document the first one produced", async () => {
    // Two pastes dispatched from one render. The second runs after the first
    // has already changed the tab's hash and the store's model. If any part
    // of the claim came from the enqueue-time closure it would describe the
    // pre-merge document, fail its own ownership check, and the page would
    // silently never appear — the exact bug serialising was meant to fix.
    const state = world();
    const enqueue = createSerialQueue();
    const claimedHashes: (string | null)[] = [];

    const merge = (producedHash: string) =>
      enqueue(async () => {
        const target = captureMergeTarget(sourcesFor(state));
        claimedHashes.push(target.claim.documentHash);
        await Promise.resolve();
        const owns = mergeStillOwnsTarget(target.claim, {
          generation: state.generation,
          activeTabId: state.activeTabId,
          targetTab: state.tabs.find((tab) => tab.id === target.claim.tabId),
          model: state.store.model,
        });
        if (owns) {
          state.tabs = [{ id: "A", hash: producedHash }];
          state.store = {
            opened: state.store.opened,
            model: { overlays: [...state.store.model.overlays, producedHash] },
          };
        }
        return owns;
      });

    const [first, second] = await Promise.all([
      merge("hash-a+1"),
      merge("hash-a+2"),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(claimedHashes).toEqual(["hash-a", "hash-a+1"]);
  });
});

describe("bindPageMergeIntent", () => {
  test("binds the tab and generation at bind time, not at run time", async () => {
    // The reader pastes on A. Decoding the image and draining the queue take
    // long enough to switch to B. Re-reading either value then would drop the
    // page into B and report success.
    const world = { activeTabId: "A" as string | null, generation: 4 };
    const seen: { tabId: string | null; generation: number }[] = [];
    const gate = deferred<void>();

    const commit = bindPageMergeIntent<[string], boolean>({
      activeTabId: () => world.activeTabId,
      generation: () => world.generation,
      enqueue: (task) => gate.promise.then(task),
      run: async (intent) => {
        seen.push({ ...intent });
        return true;
      },
    });

    world.activeTabId = "B";
    world.generation = 5;
    gate.resolve();

    expect(await commit("image.png")).toBe(true);
    expect(seen).toEqual([{ tabId: "A", generation: 4 }]);
  });

  test("every call goes through the queue", async () => {
    const order: string[] = [];
    const commit = bindPageMergeIntent<[string], boolean>({
      activeTabId: () => "A",
      generation: () => 1,
      enqueue: (task) => {
        order.push("queued");
        return task();
      },
      run: async (_intent, label) => {
        order.push(label);
        return true;
      },
    });

    await commit("first");
    await commit("second");

    expect(order).toEqual(["queued", "first", "queued", "second"]);
  });
});
