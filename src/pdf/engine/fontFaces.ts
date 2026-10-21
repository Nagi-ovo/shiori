import type { PdfEmbeddedFont } from "./fontContainer";
import { buildOutlineFont, type PdfFontOutlines, unicodeRangeOf } from "./fontOutlines";

// One face per distinct program in this session: the same subset font on
// many pages, or in two documents, loads once.
const faces = new Map<string, Promise<string | null>>();

/** FNV-1a over the bytes, enough to tell programs apart within a session. */
function hashOf(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i += 1) {
    hash ^= data[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}${data.length.toString(36)}`;
}

/**
 * Loads a document's embedded font as a browser face and resolves to its CSS
 * family, or null when the browser cannot use it. Only TrueType and OpenType
 * programs whose own cmap draws the font's text as the PDF does can load as
 * they are; the rest (bare CFF and Type 1, common in TeX and InDesign output,
 * programs a dictionary remaps or a subset that lost its cmap) and the ones
 * the browser refuses are rebuilt from their glyphs by `addOutlineFontFace`.
 */
export function loadEmbeddedFontFace(font: PdfEmbeddedFont): Promise<string | null> {
  if (font.format !== "truetype" && font.format !== "opentype") return Promise.resolve(null);
  // Before the cache: a dictionary sharing a program another draws as it is
  // must not pick up that face (audit B108).
  if (!font.ownCmap) return Promise.resolve(null);
  if (typeof FontFace === "undefined" || typeof document === "undefined") return Promise.resolve(null);
  const key = hashOf(font.data);
  let pending = faces.get(key);
  if (!pending) {
    pending = (async () => {
      const family = `shiori-pdf-${key}`;
      try {
        const face = new FontFace(family, new Uint8Array(font.data));
        await face.load();
        document.fonts.add(face);
        return family;
      } catch {
        // The browser's font sanitiser refused it; edits fall back by name.
        return null;
      }
    })();
    faces.set(key, pending);
  }
  return pending;
}

/**
 * Adds a face to `family` that draws these rebuilt glyphs. Its unicode-range
 * names only their characters, so the family's earlier faces (other pages'
 * characters) keep theirs and anything else falls through the CSS stack.
 * Resolves to the face, or null when there is nothing to draw or the
 * browser refuses it.
 */
export async function addOutlineFontFace(family: string, font: PdfFontOutlines): Promise<FontFace | null> {
  if (font.glyphs.length === 0) return null;
  if (typeof FontFace === "undefined" || typeof document === "undefined") return null;
  try {
    const face = new FontFace(family, await buildOutlineFont(font), {
      unicodeRange: unicodeRangeOf(font.glyphs.map(([unicode]) => unicode)),
    });
    await face.load();
    document.fonts.add(face);
    return face;
  } catch (error) {
    console.warn("Could not rebuild an embedded font", font.name, error);
    return null;
  }
}
