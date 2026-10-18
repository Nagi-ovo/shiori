import { describe, expect, test } from "bun:test";
import type {
  HighlightOverlay,
  InkOverlay,
  Overlay,
  TextOverlay,
} from "../pdf/model/types";
import {
  fitLiveRevealPartTiming,
  findActiveLiveOverlayReveal,
  prepareLiveOverlayCommitPresentation,
  prepareLiveOverlayRevealBatch,
  startLiveOverlayRevealBatch,
  subscribeToReducedLiveOverlayMotion,
} from "./overlayReveal";
import { liveRevealTextTimeline } from "../editor/components/overlays/revealTextTiming";
import {
  splitRevealGraphemes,
  splitRevealGraphemesFallback,
} from "../editor/components/overlays/revealTextSegmentation";

function highlight(id: string): HighlightOverlay {
  return {
    type: "highlight",
    id,
    pageId: "page-a",
    rects: [{ x: 10, y: 10, w: 90, h: 12 }],
    color: "#f4d674",
    opacity: 0.45,
  };
}

function text(id: string): TextOverlay {
  return {
    type: "text",
    id,
    pageId: "page-a",
    rect: { x: 10, y: 10, w: 120, h: 40 },
    text: "逐字出现",
    fontSize: 14,
    color: "#1a1815",
    bold: false,
    align: "left",
    fontFamily: "sans",
  };
}

describe("Live overlay reveal scheduling", () => {
  test("keeps a ten-annotation call visibly sequential in JSON order", () => {
    const overlays = Array.from({ length: 10 }, (_, index) =>
      highlight(`highlight-${index}`),
    );
    const prepared = prepareLiveOverlayRevealBatch("operation-a", overlays)!;
    const items = overlays.map((overlay) => prepared.itemsById.get(overlay.id)!);
    expect(items).toHaveLength(10);
    for (let index = 1; index < items.length; index += 1) {
      const previous = items[index - 1]!;
      expect(items[index]!.offsetMs).toBeGreaterThanOrEqual(
        previous.offsetMs + previous.durationMs,
      );
    }
    expect(prepared.totalDurationMs).toBeGreaterThan(3_000);
    expect(prepared.totalDurationMs).toBeLessThanOrEqual(8_000);
  });

  test("fast-forwards a 5,000-item tail without hiding it for minutes", () => {
    const overlays = Array.from({ length: 5_000 }, (_, index) =>
      text(`text-${index}`),
    );
    const prepared = prepareLiveOverlayRevealBatch("operation-large", overlays)!;
    expect(prepared.itemsById.size).toBe(overlays.length);
    expect(prepared.totalDurationMs).toBeGreaterThan(8_000);
    expect(prepared.totalDurationMs).toBeLessThan(20_000);
    const first = prepared.itemsById.get("text-0")!;
    const second = prepared.itemsById.get("text-1")!;
    const firstAccelerated = prepared.itemsById.get("text-24")!;
    const last = prepared.itemsById.get("text-4999")!;
    expect(first.durationMs).toBeGreaterThanOrEqual(100);
    expect(second.offsetMs).toBeGreaterThanOrEqual(
      first.offsetMs + first.durationMs,
    );
    expect(firstAccelerated.durationMs).toBeLessThan(first.durationMs);
    expect(last.offsetMs + last.durationMs).toBe(prepared.totalDurationMs);
  });

  test("fits 20 highlight rows, ink paths, and text groups inside each item", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      x: 10,
      y: 10 + index * 14,
      w: 90,
      h: 12,
    }));
    const multiHighlight: HighlightOverlay = {
      ...highlight("highlight-20"),
      rects: rows,
    };
    const multiInk: InkOverlay = {
      type: "ink",
      id: "ink-20",
      pageId: "page-a",
      paths: Array.from({ length: 20 }, (_, index) => [
        { x: 10, y: 10 + index },
        { x: 30, y: 20 + index },
      ]),
      color: "#b13a2e",
      width: 2,
    };
    const text20 = text("text-20");
    text20.text = "一二三四五六七八九十一二三四五六七八九十";
    const prepared = prepareLiveOverlayRevealBatch("operation-parts", [
      multiHighlight,
      multiInk,
      text20,
    ])!;
    const highlightItem = prepared.itemsById.get(multiHighlight.id)!;
    const inkItem = prepared.itemsById.get(multiInk.id)!;
    const textItem = prepared.itemsById.get(text20.id)!;
    expect(
      fitLiveRevealPartTiming(
        highlightItem.durationMs,
        multiHighlight.rects.length,
        54,
      ).lastEndMs,
    ).toBeLessThanOrEqual(highlightItem.durationMs);
    expect(
      fitLiveRevealPartTiming(
        inkItem.durationMs,
        multiInk.paths.length,
        48,
      ).lastEndMs,
    ).toBeLessThanOrEqual(inkItem.durationMs);
    const textTimeline = liveRevealTextTimeline(
      text20.text,
      textItem.durationMs,
    );
    expect(textTimeline.groups).toHaveLength(20);
    expect(textTimeline.lastEndMs).toBeLessThanOrEqual(textItem.durationMs);
  });

  test("does not replay an item when a virtualized page remounts after it ended", () => {
    const prepared = prepareLiveOverlayRevealBatch("operation-a", [text("text-a")])!;
    const batch = startLiveOverlayRevealBatch(prepared, 1_000);
    expect(findActiveLiveOverlayReveal([batch], "text-a", 1_001)).not.toBeNull();
    expect(
      findActiveLiveOverlayReveal([batch], "text-a", batch.endsAtMs),
    ).toBeNull();
  });

  test("segments visible characters without splitting emoji or combining marks", () => {
    expect(splitRevealGraphemes("A\u0301👩‍💻中")).toEqual(["A\u0301", "👩‍💻", "中"]);
  });

  test("fallback preserves marks, ZWJ, modifiers, and RI flag pairs", () => {
    expect(
      splitRevealGraphemesFallback("A\u0301👩‍💻👍🏽🇨🇳🇺🇸中"),
    ).toEqual(["A\u0301", "👩‍💻", "👍🏽", "🇨🇳", "🇺🇸", "中"]);
  });

  test("fallback keeps Indic virama conjuncts in one grapheme", () => {
    expect(splitRevealGraphemesFallback("हिन्दी क्ष")).toEqual([
      "हि",
      "न्दी",
      " ",
      "क्ष",
    ]);
  });

  test("reduced-motion subscription completes queued work and cleans up", () => {
    let listener: ((event: { matches: boolean }) => void) | null = null;
    let removed: unknown = null;
    const media = {
      matches: false,
      addEventListener: (
        _type: string,
        next: (event: { matches: boolean }) => void,
      ) => {
        listener = next;
      },
      removeEventListener: (_type: string, next: unknown) => {
        removed = next;
      },
    } as unknown as MediaQueryList;
    let completions = 0;
    const unsubscribe = subscribeToReducedLiveOverlayMotion(
      media,
      () => { completions += 1; },
    );
    expect(completions).toBe(0);
    const emit = listener as unknown as (event: { matches: boolean }) => void;
    emit({ matches: false });
    expect(completions).toBe(0);
    emit({ matches: true });
    expect(completions).toBe(1);
    unsubscribe();
    expect(removed).toBe(listener);
  });

  test("returns no batch for an idempotent retry with no missing overlays", () => {
    expect(prepareLiveOverlayRevealBatch("operation-a", [] as Overlay[])).toBeNull();
  });

  test("keeps the old instant selection behavior when animation is disabled", () => {
    const overlay = highlight("highlight-a");
    expect(
      prepareLiveOverlayCommitPresentation({
        enabled: false,
        reducedMotion: false,
        batchId: "operation-a",
        addedOverlays: [overlay],
        selectedIds: [overlay.id],
      }),
    ).toEqual({ reveal: null, selectedIds: [overlay.id] });
  });

  test("reduced motion completes immediately without a transient receipt", () => {
    const overlay = highlight("highlight-a");
    expect(
      prepareLiveOverlayCommitPresentation({
        enabled: true,
        reducedMotion: true,
        batchId: "operation-a",
        addedOverlays: [overlay],
        selectedIds: [overlay.id],
      }),
    ).toEqual({ reveal: null, selectedIds: [overlay.id] });
  });

  test("keeps logical selection while animation chrome is hidden", () => {
    const overlay = highlight("highlight-a");
    const presentation = prepareLiveOverlayCommitPresentation({
      enabled: true,
      reducedMotion: false,
      batchId: "operation-a",
      addedOverlays: [overlay],
      selectedIds: [overlay.id],
    });
    expect(presentation.reveal).not.toBeNull();
    expect(presentation.selectedIds).toEqual([overlay.id]);
  });
});
