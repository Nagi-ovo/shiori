import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

// Module-level stack of active traps. When dialogs stack (e.g. a confirm
// modal above another modal) every mounted trap used to install its own
// document-level handler; they all ran on each Tab and fought over focus,
// yanking it back and forth and locking the keyboard. Only the most
// recently activated trap may act, so a single shared listener consults
// the top of this stack and everything below stays passive.
const trapStack: RefObject<HTMLElement | null>[] = [];

function onTrapKeyDown(event: KeyboardEvent) {
  if (event.key !== "Tab") return;
  if (!document.querySelector("[data-shiori-modal-open]")) return;
  const panel = trapStack[trapStack.length - 1]?.current;
  if (!panel) return;
  const focusables = focusableElements(panel);
  if (focusables.length === 0) {
    event.preventDefault();
    panel.focus({ preventScroll: true });
    return;
  }
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement;
  if (!panel.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

export function useFocusTrap(
  panelRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    trapStack.push(panelRef);
    if (trapStack.length === 1) {
      document.addEventListener("keydown", onTrapKeyDown, { capture: true });
    }
    return () => {
      // Remove by identity, not pop: traps may deactivate in any order
      // (a lower dialog can close while one above it stays open).
      const index = trapStack.lastIndexOf(panelRef);
      if (index !== -1) trapStack.splice(index, 1);
      if (trapStack.length === 0) {
        document.removeEventListener("keydown", onTrapKeyDown, {
          capture: true,
        });
      }
    };
  }, [enabled, panelRef]);
}

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => {
      if (element.hidden || element.getAttribute("aria-hidden") === "true") {
        return false;
      }
      if (element.tabIndex < 0) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    });
}
