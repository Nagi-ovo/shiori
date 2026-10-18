import "../../test/setupDom";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { DocumentModel } from "../../pdf/model/types";
import { exportSnapshotKey } from "../../editor/export/exportStatus";
import {
  SYNC_SNAPSHOT_OVERLAY_LIMIT,
  useExportSnapshotKey,
  type SnapshotScheduler,
} from "./useExportSnapshotKey";

afterEach(() => {
  cleanup();
});

function modelWithNotes(count: number, text = "note"): DocumentModel {
  return {
    pages: [
      { id: "page-a", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
    ],
    overlays: Array.from({ length: count }, (_, i) => ({
      id: `note-${i}`,
      type: "note" as const,
      pageId: "page-a",
      rect: { x: 10, y: 20, w: 100, h: 50 },
      text: `${text} ${i}`,
      color: "#f7e9a8",
    })),
  };
}

/** A scheduler the test drives by hand, recording cancellations. */
function manualScheduler() {
  const pending: (() => void)[] = [];
  let cancelled = 0;
  const schedule: SnapshotScheduler = (work) => {
    pending.push(work);
    return () => {
      const index = pending.indexOf(work);
      if (index >= 0) {
        pending.splice(index, 1);
        cancelled += 1;
      }
    };
  };
  return {
    schedule,
    pending,
    cancelledCount: () => cancelled,
    runAll: () => {
      const jobs = pending.splice(0);
      for (const job of jobs) job();
    },
  };
}

describe("useExportSnapshotKey", () => {
  test("digests small models synchronously", () => {
    const model = modelWithNotes(3);
    const scheduler = manualScheduler();
    const view = renderHook(() => useExportSnapshotKey(model, scheduler.schedule));
    expect(view.result.current).toBe(exportSnapshotKey(model));
    expect(scheduler.pending).toHaveLength(0);
  });

  // The defect: every model change serialised and hashed the whole document
  // inside render — 21–27ms for 10,000 highlights, on each keystroke.
  test("defers large models off the render path and reports null meanwhile", () => {
    const model = modelWithNotes(SYNC_SNAPSHOT_OVERLAY_LIMIT + 1);
    const scheduler = manualScheduler();
    const view = renderHook(() => useExportSnapshotKey(model, scheduler.schedule));
    expect(view.result.current).toBeNull();
    expect(scheduler.pending).toHaveLength(1);
    act(() => scheduler.runAll());
    expect(view.result.current).toBe(exportSnapshotKey(model));
  });

  test("cancels a pending digest when the model changes", () => {
    const first = modelWithNotes(SYNC_SNAPSHOT_OVERLAY_LIMIT + 1, "first");
    const second = modelWithNotes(SYNC_SNAPSHOT_OVERLAY_LIMIT + 1, "second");
    const scheduler = manualScheduler();
    const view = renderHook(
      ({ model }) => useExportSnapshotKey(model, scheduler.schedule),
      { initialProps: { model: first } },
    );
    view.rerender({ model: second });
    expect(scheduler.cancelledCount()).toBe(1);
    expect(scheduler.pending).toHaveLength(1);
    act(() => scheduler.runAll());
    expect(view.result.current).toBe(exportSnapshotKey(second));
  });

  // Even a scheduler that cannot cancel must not let a superseded model's
  // digest stand in for the current one: the result is keyed by reference.
  test("never reports a stale digest for a newer model", () => {
    const first = modelWithNotes(SYNC_SNAPSHOT_OVERLAY_LIMIT + 1, "first");
    const second = modelWithNotes(SYNC_SNAPSHOT_OVERLAY_LIMIT + 1, "second");
    const jobs: (() => void)[] = [];
    const uncancellable: SnapshotScheduler = (work) => {
      jobs.push(work);
      return () => undefined;
    };
    const view = renderHook(
      ({ model }) => useExportSnapshotKey(model, uncancellable),
      { initialProps: { model: first } },
    );
    view.rerender({ model: second });
    // Run the first model's late job only.
    act(() => jobs[0]!());
    expect(view.result.current).toBeNull();
    act(() => jobs[1]!());
    expect(view.result.current).toBe(exportSnapshotKey(second));
  });
});
