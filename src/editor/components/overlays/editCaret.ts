// Hands the caret offset of a click-opened source-text edit to its textarea
// when that textarea mounts. Holds at most one request, keyed by overlay id
// and carrying only a number. It is consumed by the mount, which happens in
// the same commit as the click that opened the edit, and otherwise expires at
// the next animation frame: draft overlays keep their ids across loads, so a
// request whose editor never mounted must not surface in a later document.
// A later re-entry of the same edit opens with the browser's default caret.
const pending = new Map<string, number>();

export function requestEditCaret(overlayId: string, offset: number): void {
  pending.clear();
  pending.set(overlayId, offset);
  window.requestAnimationFrame(() => {
    if (pending.get(overlayId) === offset) pending.delete(overlayId);
  });
}

export function takeEditCaret(overlayId: string): number | undefined {
  const offset = pending.get(overlayId);
  pending.delete(overlayId);
  return offset;
}
