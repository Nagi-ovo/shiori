import type { StoreApi } from "zustand";
import { fontKeyName } from "../../pdf/engine/fontKey";
import type { Store } from "./store";

/**
 * The editor store's record of the document's own fonts, for edit boxes.
 * Fonts are keyed by name and program (src/pdf/engine/fontKey.ts), so two
 * subsets PDFium names alike keep their own face and characters. A draft
 * saved before that names its edit's font alone; the bare name keeps the
 * first face registered under it and every program's characters, as it
 * did then.
 */
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
      const addChars = (key: string, chars: string) => {
        const seen = nextChars[key];
        const merged = new Set(seen ?? []);
        const before = merged.size;
        for (const ch of chars) merged.add(ch);
        if (merged.size !== before) {
          nextChars[key] = merged;
          charsChanged = true;
        }
      };
      for (const { baseFontName, faceFamily, chars } of entries) {
        if (nextFaces[baseFontName] !== faceFamily) {
          nextFaces[baseFontName] = faceFamily;
          facesChanged = true;
        }
        if (chars) addChars(baseFontName, chars);
        const bare = fontKeyName(baseFontName);
        if (bare === baseFontName) continue;
        if (nextFaces[bare] === undefined) {
          nextFaces[bare] = faceFamily;
          facesChanged = true;
        }
        if (chars) addChars(bare, chars);
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
