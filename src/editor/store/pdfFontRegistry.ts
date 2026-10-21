import type { StoreApi } from "zustand";
import type { Store } from "./store";

/** The editor store's record of the document's own fonts, for edit boxes. */
export function pdfFontRegistry(
  set: StoreApi<Store>["setState"],
  get: StoreApi<Store>["getState"],
): Pick<Store, "registerPdfFontFaces"> {
  return {
    registerPdfFontFaces: (entries) => {
      const { pdfFontFaces, pdfFontChars } = get();
      let facesChanged = false;
      let charsChanged = false;
      const nextFaces = { ...pdfFontFaces };
      const nextChars = { ...pdfFontChars };
      for (const { baseFontName, faceFamily, chars } of entries) {
        if (nextFaces[baseFontName] !== faceFamily) {
          nextFaces[baseFontName] = faceFamily;
          facesChanged = true;
        }
        if (chars) {
          const seen = nextChars[baseFontName];
          const merged = new Set(seen ?? []);
          const before = merged.size;
          for (const ch of chars) merged.add(ch);
          if (merged.size !== before) {
            nextChars[baseFontName] = merged;
            charsChanged = true;
          }
        }
      }
      // No-op when nothing moved — page re-renders re-register the same
      // faces and must not churn subscribers.
      if (facesChanged || charsChanged) {
        set({
          ...(facesChanged ? { pdfFontFaces: nextFaces } : {}),
          ...(charsChanged ? { pdfFontChars: nextChars } : {}),
        });
      }
    },
  };
}
