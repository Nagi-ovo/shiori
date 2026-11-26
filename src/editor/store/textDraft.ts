import { pageOrigin } from "../../pdf/model/pageSpace";
import type { DocumentModel, Overlay } from "../../pdf/model/types";

export function isDiscardableTextDraft(overlay: Overlay): boolean {
  switch (overlay.type) {
    case "text":
    case "note":
    case "callout":
      return overlay.text.trim() === "";
    case "contentText": {
      const source = overlay.sourceStyle;
      return overlay.text === overlay.originalText && !overlay.angle &&
        (!source || (Object.keys(source) as (keyof typeof source)[]).every(
          (key) => overlay[key] === source[key],
        ));
    }
    default:
      return false;
  }
}

export function modelsEqual(a: DocumentModel, b: DocumentModel): boolean {
  if (a.pages.length !== b.pages.length || a.overlays.length !== b.overlays.length) {
    return false;
  }
  for (let i = 0; i < a.pages.length; i += 1) {
    const left = a.pages[i]!;
    const right = b.pages[i]!;
    if (
      left.id !== right.id ||
      left.sourceIndex !== right.sourceIndex ||
      left.rotation !== right.rotation ||
      pageOrigin(left).x !== pageOrigin(right).x ||
      pageOrigin(left).y !== pageOrigin(right).y ||
      left.widthPt !== right.widthPt ||
      left.heightPt !== right.heightPt ||
      left.blank !== right.blank
    ) {
      return false;
    }
  }
  for (let i = 0; i < a.overlays.length; i += 1) {
    if (JSON.stringify(a.overlays[i]) !== JSON.stringify(b.overlays[i])) {
      return false;
    }
  }
  return JSON.stringify(a.flowChains ?? []) === JSON.stringify(b.flowChains ?? []);
}
