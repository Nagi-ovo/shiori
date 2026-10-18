import type { Overlay } from "../pdf/model/types";

export type LiveOverlayRevealItem = {
  overlayId: string;
  offsetMs: number;
  durationMs: number;
};

export type PreparedLiveOverlayRevealBatch = {
  id: string;
  itemsById: ReadonlyMap<string, LiveOverlayRevealItem>;
  totalDurationMs: number;
};

export type LiveOverlayRevealBatch = PreparedLiveOverlayRevealBatch & {
  startedAtMs: number;
  endsAtMs: number;
};

export type ActiveLiveOverlayReveal = {
  batch: LiveOverlayRevealBatch;
  item: LiveOverlayRevealItem;
  mountedAtMs: number;
};

const ITEM_GAP_MS = 48;
const HUMAN_PACED_ITEM_LIMIT = 24;
const MAX_HUMAN_ITEM_DURATION_MS = 1_200;
const ACCELERATED_TAIL_BUDGET_MS = 6_000;

export type LiveRevealPartTiming = {
  staggerMs: number;
  partDurationMs: number;
  lastEndMs: number;
};

/**
 * Fits repeated strokes/rows inside one annotation's allotted window. The
 * final part is guaranteed to finish no later than `itemDurationMs`, even for
 * adversarial restored/test data whose duration is only a few milliseconds.
 */
export function fitLiveRevealPartTiming(
  itemDurationMs: number,
  partCount: number,
  preferredStaggerMs: number,
): LiveRevealPartTiming {
  const duration = Math.max(1, Math.floor(itemDurationMs));
  const count = Math.max(1, Math.floor(partCount));
  const staggerMs = count === 1
    ? 0
    : Math.max(
        0,
        Math.min(
          Math.max(0, Math.floor(preferredStaggerMs)),
          Math.floor((duration - 1) / (count - 1)),
        ),
      );
  const partDurationMs = Math.max(
    1,
    duration - staggerMs * (count - 1),
  );
  return {
    staggerMs,
    partDurationMs,
    lastEndMs: staggerMs * (count - 1) + partDurationMs,
  };
}

function idealDuration(overlay: Overlay): number {
  if (overlay.type === "highlight") {
    return 300 + Math.max(0, overlay.rects.length - 1) * 54;
  }
  if (overlay.type === "underline" || overlay.type === "strikethrough") {
    return 280 + Math.max(0, overlay.rects.length - 1) * 44;
  }
  if (overlay.type === "ink") {
    const pointCount = overlay.paths.reduce((sum, path) => sum + path.length, 0);
    return 320 + pointCount * 1.8 +
      Math.max(0, overlay.paths.length - 1) * 48;
  }
  if (
    overlay.type === "note" ||
    overlay.type === "text" ||
    overlay.type === "callout"
  ) {
    const visibleUnits = Math.min(64, Array.from(overlay.text).length);
    const typingMs = Math.min(
      800,
      Math.max(100, Math.max(0, visibleUnits - 1) * 22 + 70),
    );
    return (overlay.type === "note" ? 220 : overlay.type === "callout" ? 520 : 80) +
      typingMs;
  }
  if (overlay.type === "rect") return 360;
  return 300;
}

/**
 * Builds the O(n) schedule before native mutation authorization. Committing the
 * prepared batch is O(1): the store only stamps its absolute start and appends
 * the object alongside the already-prepared document snapshot.
 */
export function prepareLiveOverlayRevealBatch(
  id: string,
  overlays: readonly Overlay[],
): PreparedLiveOverlayRevealBatch | null {
  if (overlays.length === 0) return null;
  const itemsById = new Map<string, LiveOverlayRevealItem>();
  const tailCount = Math.max(0, overlays.length - HUMAN_PACED_ITEM_LIMIT);
  const acceleratedTailDuration = tailCount > 0
    ? Math.max(1, Math.floor(ACCELERATED_TAIL_BUDGET_MS / tailCount))
    : 0;
  let offsetMs = 0;
  overlays.forEach((overlay, index) => {
    const humanDuration = Math.max(
      1,
      Math.min(MAX_HUMAN_ITEM_DURATION_MS, Math.round(idealDuration(overlay))),
    );
    // Normal calls (including the requested 10-item workflow) keep their full
    // human pace. Pathological but valid 5,000-item calls animate the opening
    // sequence normally, then fast-forward the tail in JSON order instead of
    // hiding the document for tens of minutes.
    const durationMs = index < HUMAN_PACED_ITEM_LIMIT
      ? humanDuration
      : Math.min(humanDuration, acceleratedTailDuration);
    itemsById.set(overlay.id, { overlayId: overlay.id, offsetMs, durationMs });
    const gapMs = index === overlays.length - 1 ||
        index >= HUMAN_PACED_ITEM_LIMIT
      ? 0
      : ITEM_GAP_MS;
    offsetMs += durationMs + gapMs;
  });
  return { id, itemsById, totalDurationMs: offsetMs };
}

/**
 * Rebase already-budgeted reveal items when their virtualized page first
 * mounts. Durations remain exactly as prepared; only stale offscreen offsets
 * are compacted into a fresh, page-local sequence.
 */
export function prepareMountedOverlayRevealBatch(
  id: string,
  items: readonly LiveOverlayRevealItem[],
): PreparedLiveOverlayRevealBatch | null {
  if (items.length === 0) return null;
  const itemsById = new Map<string, LiveOverlayRevealItem>();
  let offsetMs = 0;
  items.forEach((item, index) => {
    const durationMs = Math.max(1, Math.floor(item.durationMs));
    itemsById.set(item.overlayId, {
      overlayId: item.overlayId,
      offsetMs,
      durationMs,
    });
    offsetMs += durationMs + (index === items.length - 1 ? 0 : ITEM_GAP_MS);
  });
  return { id, itemsById, totalDurationMs: offsetMs };
}

export function startLiveOverlayRevealBatch(
  prepared: PreparedLiveOverlayRevealBatch,
  startedAtMs: number,
): LiveOverlayRevealBatch {
  return {
    ...prepared,
    startedAtMs,
    endsAtMs: startedAtMs + prepared.totalDurationMs,
  };
}

export function findActiveLiveOverlayReveal(
  batches: readonly LiveOverlayRevealBatch[],
  overlayId: string,
  mountedAtMs: number,
): ActiveLiveOverlayReveal | null {
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index]!;
    const item = batch.itemsById.get(overlayId);
    if (!item) continue;
    const itemEnd = batch.startedAtMs + item.offsetMs + item.durationMs;
    if (mountedAtMs >= itemEnd) return null;
    return { batch, item, mountedAtMs };
  }
  return null;
}

export function liveRevealAnimationDelay(
  reveal: ActiveLiveOverlayReveal,
  extraOffsetMs = 0,
): string {
  const start = reveal.batch.startedAtMs + reveal.item.offsetMs + extraOffsetMs;
  return `${start - reveal.mountedAtMs}ms`;
}

export function liveRevealAnimationDuration(
  reveal: ActiveLiveOverlayReveal,
  ratio = 1,
): string {
  return `${Math.max(1, Math.round(reveal.item.durationMs * ratio))}ms`;
}

export function prefersReducedLiveOverlayMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** One root-level subscription; callers own the MediaQueryList lifecycle. */
export function subscribeToReducedLiveOverlayMotion(
  media: MediaQueryList,
  onReduced: () => void,
): () => void {
  const handleChange = (event: Pick<MediaQueryListEvent, "matches">) => {
    if (event.matches) onReduced();
  };
  handleChange(media);
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }
  media.addListener(handleChange);
  return () => media.removeListener(handleChange);
}

export function prepareLiveOverlayCommitPresentation({
  enabled,
  reducedMotion,
  batchId,
  addedOverlays,
  selectedIds,
}: {
  enabled: boolean;
  reducedMotion: boolean;
  batchId: string;
  addedOverlays: readonly Overlay[];
  selectedIds: string[];
}): {
  reveal: PreparedLiveOverlayRevealBatch | null;
  selectedIds: string[];
} {
  const animate = enabled && !reducedMotion && addedOverlays.length > 0;
  return {
    reveal: animate
      ? prepareLiveOverlayRevealBatch(batchId, addedOverlays)
      : null,
    // Selection is interaction state, not animation state. Renderers suppress
    // its chrome while the receipt is active, then reveal it naturally when
    // the batch ends without breaking Delete/tool-bar behavior in the interim.
    selectedIds,
  };
}
