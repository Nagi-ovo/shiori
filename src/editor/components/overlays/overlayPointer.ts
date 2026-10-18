import type { PointerEvent as ReactPointerEvent } from "react";

export function localPointFromPointer(
  root: HTMLDivElement,
  event: ReactPointerEvent | PointerEvent,
): { x: number; y: number } {
  const rect = root.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

export function pdfLinkAtPoint(
  clientX: number,
  clientY: number,
  overlayRoot: HTMLDivElement | null,
): HTMLAnchorElement | null {
  const pageRoot = overlayRoot?.parentElement;
  if (!pageRoot) return null;
  const match = document
    .elementsFromPoint(clientX, clientY)
    .find(
      (el): el is HTMLAnchorElement =>
        el instanceof HTMLAnchorElement &&
        el.dataset.shioriPdfLink === "true" &&
        pageRoot.contains(el),
    );
  return match ?? null;
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable ||
    target.closest("[contenteditable='true']") !== null
  );
}

export function isSelectablePdfTextAtPoint(
  clientX: number,
  clientY: number,
  overlayRoot: HTMLDivElement | null,
): boolean {
  const pageRoot = overlayRoot?.parentElement;
  if (!pageRoot) return false;
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!pageRoot.contains(el)) continue;
    if (el instanceof HTMLElement && el.dataset.role === "interactive") {
      return false;
    }
    if (
      el instanceof HTMLAnchorElement &&
      el.dataset.shioriPdfLink === "true"
    ) {
      return false;
    }
    const textNode = el.closest(".shioriTextLayer span, .shioriTextLayer br");
    if (textNode && pageRoot.contains(textNode)) return true;
  }
  return false;
}

export function releaseCapturedPointers(
  root: HTMLDivElement | null,
  pointerIds: Iterable<number>,
): void {
  if (!root) return;
  for (const id of pointerIds) {
    if (!root.hasPointerCapture(id)) continue;
    try {
      root.releasePointerCapture(id);
    } catch {
      // Pointer capture may already have been lost.
    }
  }
}
