// Layout policy for the workspace tab strip.
//
// The old strip let tabs shrink to 46px — room for the kind badge, an
// ellipsis, and nothing else, so a squeezed strip degraded into a row of
// format labels ("PDF B.", "PDF H.") with every title gone. Tabs now stop
// shrinking at a readable floor; when the strip cannot hold all of them at
// that floor, the least recently used tabs fold into a "⋯ +N" chip instead
// of becoming unreadable stubs. The active tab never folds.

/** Floor below which a tab stops saying anything useful. */
export const TAB_MIN_WIDTH = 88;
/** The active tab keeps more of its title while inactive ones squeeze. */
export const ACTIVE_TAB_MIN_WIDTH = 132;
/** The "⋯ +N" overflow chip. */
export const OVERFLOW_CHIP_WIDTH = 52;
/** Gap between tabs (matches the strip's flex gap). */
export const TAB_GAP = 2;

/** Ceiling for one tab; a longer title ellipsizes rather than pushing others out. */
export const TAB_MAX_WIDTH = 240;

// Enough to estimate a tab's natural width without measuring it. Tabs are
// sized by their content now, so planning against the 88px floor would fold
// tabs that had room to sit on the strip — six short names would "need"
// 528px while actually taking 380. Estimated from the strip's own metrics:
// 12px + 6px padding, a 20px aux column plus its 6px gap, and the average
// advance of the 12.5px UI sans. Being a few pixels out only shifts where
// the last tab folds, which is why this is not worth a measuring pass.
const TAB_PADDING_PX = 18;
const TAB_AUX_PX = 26;
const NARROW_CHAR_PX = 6.4;
const WIDE_CHAR_PX = 12.5;
const WIDE_CHAR =
  /[ᄀ-ᇿ⺀-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

/** Roughly how wide a tab wants to be, before the floor and the ceiling. */
export function estimateTabWidth(title: string): number {
  let text = 0;
  for (const char of title) {
    text += WIDE_CHAR.test(char) ? WIDE_CHAR_PX : NARROW_CHAR_PX;
  }
  return Math.ceil(TAB_PADDING_PX + TAB_AUX_PX + text);
}

export type TabStripPlanItem = {
  id: string;
  updatedAt?: number;
  /** Used to estimate the tab's natural width; falls back to the floor. */
  title?: string;
};

export type TabStripPlan<T extends TabStripPlanItem> = {
  /** In original order; always contains the active tab (when present). */
  visible: T[];
  /** Least recently used first — what the ⋯ +N chip holds. */
  overflow: T[];
};

/**
 * Decide which tabs stay on the strip at `availableWidth` (the space left
 * for tabs after the strip's padding and the "+" button) and which fold
 * into the overflow chip.
 */
export function planTabStrip<T extends TabStripPlanItem>(
  tabs: readonly T[],
  activeTabId: string | null,
  availableWidth: number,
): TabStripPlan<T> {
  const total = tabs.length;
  if (total === 0) return { visible: [], overflow: [] };

  // Fold least-recently-used first; the active tab is exempt. Ties (no
  // updatedAt) fold from the left, which is also the oldest end in practice.
  const foldable = tabs
    .filter((t) => t.id !== activeTabId)
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));

  // The least a tab can occupy, which is what decides whether it fits: a long
  // title squeezes down to the floor, a short one is already narrower than
  // the floor and is never padded out to it.
  const widthOf = (tab: T): number => {
    const floor =
      tab.id === activeTabId ? ACTIVE_TAB_MIN_WIDTH : TAB_MIN_WIDTH;
    if (tab.title == null) return floor;
    return Math.min(floor, estimateTabWidth(tab.title));
  };

  let keptCount = total;
  let keptWidth = tabs.reduce((sum, tab) => sum + widthOf(tab), 0);
  const fullWidth = keptWidth + Math.max(0, keptCount - 1) * TAB_GAP;
  if (fullWidth <= availableWidth) {
    return { visible: [...tabs], overflow: [] };
  }

  // Accumulate each LRU removal exactly once. The previous implementation
  // rebuilt a Set, sliced, filtered and reduced the entire tab list for every
  // candidate count, turning ordinary resize/activation renders into O(N²).
  let foldCount = 0;
  for (const candidate of foldable) {
    if (keptCount <= 1) break;
    keptWidth -= widthOf(candidate);
    keptCount -= 1;
    foldCount += 1;
    const foldedWidth =
      keptWidth +
      Math.max(0, keptCount - 1) * TAB_GAP +
      OVERFLOW_CHIP_WIDTH +
      TAB_GAP;
    if (foldedWidth <= availableWidth) break;
  }

  const folded = new Set(foldable.slice(0, foldCount).map((t) => t.id));

  return {
    visible: tabs.filter((t) => !folded.has(t.id)),
    overflow: foldable.slice(0, foldCount),
  };
}

/**
 * Split "Attention Is All You Need.pdf" into basename + extension so the
 * strip can ellipsize the basename while the (dim, secondary) extension
 * survives — and can be dropped entirely on very narrow tabs. A title
 * without a recognizable extension comes back whole.
 */
export function splitTitleExtension(title: string): {
  base: string;
  ext: string;
} {
  const match = /^(.+?)(\.[A-Za-z0-9]{1,8})$/.exec(title);
  if (!match) return { base: title, ext: "" };
  return { base: match[1] ?? title, ext: match[2] ?? "" };
}
