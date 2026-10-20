import { useEffect, type RefObject } from "react";

// Mark everything outside `ref` as `inert` for as long as the hook is active.
//
// `useFocusTrap` already cycles Tab inside the dialog, but Tab is only one of
// the ways out. A screen reader's browse cursor, a touch user's swipe-to-next,
// and a find-in-page hit all walk the DOM directly and sail straight past a Tab
// trap into the page behind the dialog — with no signal that they have left it.
// `inert` is the one primitive that closes all of those at once: it removes the
// subtree from the tab order, from hit-testing, and from the accessibility tree.
//
// Shiori's `Modal` renders inline rather than through a portal, so "the
// background" is not a single node. Walk from the dialog up to <body> and mark
// every sibling on the way; that is exactly the set a user must not reach.
//
// Only siblings this instance actually marked get cleared on unmount, so
// stacked dialogs unwind correctly: the second dialog marks the first, and
// releasing the second restores it without disturbing what the first had
// already marked underneath.
//
// A sibling carrying `data-shiori-stays-live` is left alone: the toast host
// paints above every dialog, and inerting it silenced its live regions and
// disarmed its buttons while it was still on screen.
export function useInertBackground(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    const node = ref.current;
    if (!node) return;

    const marked: HTMLElement[] = [];
    let current: HTMLElement | null = node;
    while (current && current !== document.body) {
      const parent: HTMLElement | null = current.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (
          sibling !== current &&
          sibling instanceof HTMLElement &&
          !sibling.inert &&
          !sibling.hasAttribute("data-shiori-stays-live")
        ) {
          sibling.inert = true;
          marked.push(sibling);
        }
      }
      current = parent;
    }

    return () => {
      for (const element of marked) element.inert = false;
    };
  }, [enabled, ref]);
}
