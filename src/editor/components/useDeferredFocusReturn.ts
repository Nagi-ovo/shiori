import { useEffect, useState } from "react";

function focusedElement(): HTMLElement | null {
  return typeof document !== "undefined" &&
    document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

/**
 * Puts focus back on whatever opened a deferred modal once it closes, if
 * nothing else took it.
 *
 * The modal shells (Modal, SettingsPanel) capture `document.activeElement`
 * when they render and return focus there on close. After a slow load that
 * element is deferModal's loading notice, which held focus when the real
 * dialog rendered and was unmounted in the same commit, so on close the shell
 * found its target disconnected and focus fell to <body>. The trigger is
 * captured here instead, in the render where `open` turns true, before any
 * stand-in can take focus.
 *
 * Focus is only moved when it was lost (on <body>): a dialog that closes as
 * another opens must not pull focus out from under the new one.
 */
export function useDeferredFocusReturn(open: boolean): void {
  const [opening, setOpening] = useState(() => ({
    open,
    returnTo: open ? focusedElement() : null,
  }));
  if (opening.open !== open) {
    setOpening({ open, returnTo: open ? focusedElement() : null });
  }
  const returnTo = opening.open ? opening.returnTo : null;
  useEffect(() => {
    if (!returnTo) return;
    return () => {
      // Deferred a microtask: when the wrapper itself unmounts, its cleanup
      // runs before the dialog's own, while the dialog still holds the page
      // (trigger included) inert and focus() on it would do nothing.
      queueMicrotask(() => {
        const active = document.activeElement;
        if ((active === null || active === document.body) && returnTo.isConnected) {
          returnTo.focus({ preventScroll: true });
        }
      });
    };
  }, [returnTo]);
}
