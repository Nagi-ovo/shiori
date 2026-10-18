/**
 * Which of the two rows under the top bar names the open document.
 *
 * A phone rendered both: a filename line (~32px, `TopBar`) and the tab strip
 * (~40px, `DocumentShell`). With one document open that is ~72px of chrome
 * saying the same thing twice — the strip is then a single tab carrying the
 * same name, plus a "+".
 *
 * This returns ONE row rather than two flags on purpose: "both" and
 * "neither" are not states it can produce. Neither is a legal layout. A
 * phone has no other place for the name — the top bar's inline title only
 * fits from tablet width up — so a phone that renders neither row is a
 * phone where the reader cannot tell which of their documents is on screen.
 *
 * Reader mode is deliberately NOT an input here: it hides the top bar and
 * the strip together, one level up in `DocumentShell`, and that stays its
 * own decision.
 */
export type DocumentIdentityRow = "fileName" | "tabStrip";

export type DocumentIdentityRowOptions = {
  /**
   * A compact viewport that is not a tablet — the only layout where the
   * filename is not already inline in the top bar. See `useIsPhone`.
   */
  isPhone: boolean;
  /** Open workspace tabs, all document kinds. */
  tabCount: number;
  hasFileName: boolean;
};

export function documentIdentityRow({
  isPhone,
  tabCount,
  hasFileName,
}: DocumentIdentityRowOptions): DocumentIdentityRow {
  // Desktop and tablets are unchanged: the name is inline in the top bar
  // (so the second line never rendered there anyway) and the strip always
  // shows, at every tab count.
  if (!isPhone) return "tabStrip";
  // Two or more documents: the tabs already carry their names, and the way
  // to switch between them is worth more than a second copy of the active
  // one's.
  if (tabCount >= 2) return "tabStrip";
  // One document, or none. The strip would be a single tab plus a "+", so
  // the filename line says it in less room.
  //
  // The fallback keeps this total: a shell with no title to show gets the
  // strip rather than an empty row. App has no such branch — every one
  // passes a title — but it is why this cannot answer "neither".
  return hasFileName ? "fileName" : "tabStrip";
}
