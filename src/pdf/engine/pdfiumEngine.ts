import {
  pdfCoreCancel,
  pdfCoreClose,
  pdfCoreHideAnnotations,
  pdfCoreLinks,
  pdfCoreOpen,
  pdfCoreOutline,
  pdfCoreDecryptedCopy,
  pdfCoreEncryptLikeSource,
  pdfCoreFontOutlines,
  pdfCorePageFonts,
  pdfCorePageGeometry,
  pdfCorePageText,
  pdfCoreRender,
  pdfCoreSecurity,
} from "../../platform/pdfCore";
import { importFileAnnotations } from "../import/annotations";
import { MAX_THUMBNAIL_CANVAS_PIXELS, assertCanvasPixelBudget } from "../openPolicy";
import { releaseCanvasBackingStore } from "../render/canvasMemory";
import { retainPdfSourceBytes } from "../render/pdfByteOwnership";
import { decodeEmbeddedFonts } from "./fontContainer";
import { addOutlineFontFace, loadEmbeddedFontFace } from "./fontFaces";
import { decodeFontOutlines } from "./fontOutlines";
import { pageGeometryFromPdfium } from "./pdfiumGeometry";
import { pageTextFromPdfiumGlyphs } from "./pdfiumText";
import type { PdfDocument, PdfEngine, PdfLink, PdfPageGeometry, PdfSecurity } from "./types";

/**
 * The app's PDF engine (docs/PLAN-RUST-PDF-CORE-2026-09.md): shiori-core
 * opens, draws and reads documents through a bridge to wherever it runs —
 * the desktop render thread over Tauri IPC, or a web worker running it as
 * wasm (./wasm/coreClient.ts). A file it cannot open is reported as such
 * (classifyPdfOpenError); a page it cannot draw or read fails that request.
 */

/** shiori-core, as the engine reaches it (src/platform/pdfCore.ts on desktop). */
export type PdfCoreBridge = {
  open: typeof pdfCoreOpen;
  render: typeof pdfCoreRender;
  cancel: typeof pdfCoreCancel;
  close: typeof pdfCoreClose;
  hideAnnotations: typeof pdfCoreHideAnnotations;
  outline: typeof pdfCoreOutline;
  links: typeof pdfCoreLinks;
  pageText: typeof pdfCorePageText;
  decryptedCopy: typeof pdfCoreDecryptedCopy;
  pageGeometry: typeof pdfCorePageGeometry;
  pageFonts: typeof pdfCorePageFonts;
  fontOutlines: typeof pdfCoreFontOutlines;
  security: typeof pdfCoreSecurity;
  encryptLikeSource: typeof pdfCoreEncryptLikeSource;
};

/**
 * How the regions of this session went: drawn, or failed. Read by
 * diagnostics and perf probes; nothing depends on it.
 */
export const pdfiumRenderStats = { drawn: 0, failed: 0 };
let nextTicket = 1;

/** A core error as an Error, whose message classifyPdfOpenError reads. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The core's report, or null for a file without encryption. */
function securityOf(report: Awaited<ReturnType<PdfCoreBridge["security"]>>): PdfSecurity | null {
  if (report.revision == null) return null;
  return {
    revision: report.revision,
    permissions: report.permissions >>> 0,
    userPermissions: report.userPermissions >>> 0,
  };
}

/** A document the core opened. */
type CoreDoc = {
  id: number;
  pages: PdfPageGeometry[];
  /** "unknown" when PDFium could not report it: never read as unencrypted. */
  security: PdfSecurity | null | "unknown";
  /** Embedded fonts by BaseFont name: the face's CSS family, or null. */
  faces: Map<string, string | null>;
  /**
   * Embedded fonts the browser cannot load as filed, rebuilt from PDFium's
   * glyphs a page at a time: their family, and the characters asked for.
   */
  rebuilt: Map<string, { family: string; asked: Set<number>; loaded: boolean }>;
  /** Faces of rebuilt fonts, removed with the document. */
  rebuiltFaces: FontFace[];
  closed: boolean;
};

export function createPdfiumEngine(core: PdfCoreBridge, label = "PDFium 7881"): PdfEngine {
  const docs = new WeakMap<PdfDocument, CoreDoc>();
  // Links with Named actions, from the importer's raw pass: PDFium drops them.
  const namedLinks = new WeakMap<PdfDocument, Map<number, PdfLink[]>>();

  const entryOf = (doc: PdfDocument): CoreDoc => {
    const entry = docs.get(doc);
    if (!entry) throw new Error("pdf-core-closed");
    return entry;
  };

  /**
   * Adds faces for the characters this page sets in rebuilt fonts that no
   * earlier page asked for. A character is asked for once, drawn or not.
   */
  const rebuildFonts = async (
    entry: CoreDoc,
    sourceIndex: number,
    glyphs: ReadonlyArray<{ text: string; fontName: string; generated: boolean }>,
  ): Promise<void> => {
    const wanted = new Set<string>();
    for (const glyph of glyphs) {
      const rebuilt = glyph.generated ? undefined : entry.rebuilt.get(glyph.fontName);
      if (!rebuilt) continue;
      for (const ch of glyph.text) {
        const unicode = ch.codePointAt(0)!;
        if (unicode >= 0x20 && !rebuilt.asked.has(unicode)) wanted.add(glyph.fontName);
      }
    }
    if (wanted.size === 0) return;
    let fonts;
    try {
      fonts = decodeFontOutlines(await core.fontOutlines(entry.id, sourceIndex, [...wanted]));
    } catch (error) {
      console.warn("PDFium could not rebuild a page's fonts", error);
      return;
    }
    await Promise.all(
      fonts.map(async (font) => {
        const rebuilt = entry.rebuilt.get(font.name);
        if (!rebuilt) return;
        // Pages read concurrently: claim the characters before loading.
        const fresh = font.glyphs.filter(([unicode]) => !rebuilt.asked.has(unicode));
        for (const [unicode] of font.glyphs) rebuilt.asked.add(unicode);
        for (const glyph of glyphs) {
          if (glyph.fontName === font.name && !glyph.generated) {
            for (const ch of glyph.text) rebuilt.asked.add(ch.codePointAt(0)!);
          }
        }
        const face = await addOutlineFontFace(rebuilt.family, { ...font, glyphs: fresh });
        if (!face) return;
        if (entry.closed) {
          document.fonts.delete(face);
          return;
        }
        entry.rebuiltFaces.push(face);
        rebuilt.loaded = true;
      }),
    );
  };

  const engine: PdfEngine = {
    label,

    load: async (bytes, options) => {
      let id: number;
      try {
        id = await core.open(bytes, options.password);
      } catch (error) {
        throw asError(error);
      }
      let pages: PdfPageGeometry[];
      try {
        pages = (await core.pageGeometry(id)).map(pageGeometryFromPdfium);
      } catch (error) {
        core.close(id);
        throw asError(error);
      }
      let security: PdfSecurity | null | "unknown";
      try {
        security = securityOf(await core.security(id));
      } catch (error) {
        // The document still opens for reading; asking for its security
        // then throws, and an export refuses rather than guess it is
        // unencrypted (src/pdf/export/encryptedSource.ts).
        console.warn("PDFium could not report the document's security", error);
        security = "unknown";
      }
      // An opaque handle: callers only pass it back to the engine.
      const doc = Object.freeze({}) as unknown as PdfDocument;
      docs.set(doc, { id, pages, security, faces: new Map(), rebuilt: new Map(), rebuiltFaces: [], closed: false });
      return { doc, bytes: retainPdfSourceBytes(bytes) };
    },

    pageCount: (doc) => entryOf(doc).pages.length,

    pageGeometry: async (doc) => entryOf(doc).pages.map((page) => ({ ...page })),

    importAnnotations: async (doc, pages, bytes, now, options) => {
      const entry = entryOf(doc);
      const hidden = new Map<number, Array<{ subtype: string; rect: [number, number, number, number] }>>();
      const importOptions = {
        ...options,
        // pdf-lib reads the file for import but cannot decrypt; PDFium can.
        decryptedBytes: () => core.decryptedCopy(entry.id),
        onNamedLinks: (sourceIndex: number, links: PdfLink[]) => {
          options?.onNamedLinks?.(sourceIndex, links);
          const byPage = namedLinks.get(doc) ?? new Map<number, PdfLink[]>();
          byPage.set(sourceIndex, links);
          namedLinks.set(doc, byPage);
        },
        onSuppress: (sourceIndex: number, annotation: { subtype: string; rect: [number, number, number, number] }) => {
          options?.onSuppress?.(sourceIndex, annotation);
          const keys = hidden.get(sourceIndex) ?? [];
          keys.push(annotation);
          hidden.set(sourceIndex, keys);
        },
      };
      const overlays = await importFileAnnotations(pages, bytes, now, importOptions);
      // The pages Shiori draws annotations over must not paint them too. The
      // render thread handles these before any tile queued after them.
      await Promise.all(
        [...hidden].map(([sourceIndex, keys]) =>
          core.hideAnnotations(entry.id, sourceIndex, keys).catch((error: unknown) => {
            // The page then draws the annotation under its overlay: worth a
            // warning, not a failed open.
            console.warn("PDFium could not hide imported annotations", error);
            return 0;
          }),
        ),
      );
      return overlays;
    },

    thumbnail: async (doc, pageNumber, maxCssWidth) => {
      const page = docs.get(doc)?.pages[pageNumber - 1];
      if (!page) return undefined;
      const turned = page.rotation === 90 || page.rotation === 270;
      const width = turned ? page.heightPt : page.widthPt;
      const height = turned ? page.widthPt : page.heightPt;
      // pdf.js's thumbnail: twice the CSS width, never under 0.2×.
      const scale = Math.max(0.2, (maxCssWidth * 2) / width);
      const region = { x: 0, y: 0, width: Math.ceil(width * scale), height: Math.ceil(height * scale) };
      const canvas = document.createElement("canvas");
      try {
        assertCanvasPixelBudget(region.width, region.height, MAX_THUMBNAIL_CANVAS_PIXELS);
        await engine.renderRegion(
          doc,
          { sourceIndex: pageNumber - 1, rotation: page.rotation, scale, dpr: 1, region, priority: "thumbnail" },
          canvas,
        ).done;
        return canvas.toDataURL("image/jpeg", 0.55);
      } catch {
        return undefined;
      } finally {
        releaseCanvasBackingStore(canvas);
      }
    },

    renderRegion: (doc, request, target) => {
      const entry = docs.get(doc);
      if (!entry) return { cancel: () => {}, done: Promise.reject(new Error("pdf-core-closed")) };
      const { sourceIndex, rotation, scale, dpr, region, priority, annotations } = request;
      const width = Math.max(1, Math.round(region.width));
      const height = Math.max(1, Math.round(region.height));
      const ticket = nextTicket++;
      let cancelled = false;
      const done = core.render(
        entry.id,
        sourceIndex,
        {
          rotation,
          pixelsPerPoint: scale * dpr,
          x: Math.round(region.x),
          y: Math.round(region.y),
          width,
          height,
          annotations,
        },
        priority ?? "visible",
        ticket,
      ).then(
        (rgba) => {
          if (cancelled) return;
          target.width = width;
          target.height = height;
          target.style.width = `${width / dpr}px`;
          target.style.height = `${height / dpr}px`;
          const context = target.getContext("2d");
          context?.putImageData(new ImageData(rgba, width, height), 0, 0);
          pdfiumRenderStats.drawn += 1;
        },
        (error: unknown) => {
          if (cancelled || error === "cancelled") return;
          pdfiumRenderStats.failed += 1;
          throw asError(error);
        },
      );
      return {
        cancel: () => {
          cancelled = true;
          core.cancel([ticket]);
        },
        done,
      };
    },

    outline: (doc) => core.outline(entryOf(doc).id),

    pageLinks: async (doc, sourceIndex) => {
      const links = await core.links(entryOf(doc).id, sourceIndex);
      return [...links, ...(namedLinks.get(doc)?.get(sourceIndex) ?? [])];
    },

    pageText: async (doc, sourceIndex, options) => {
      const entry = entryOf(doc);
      const read = await core.pageText(entry.id, sourceIndex);
      options?.checkAbort?.();
      const text = pageTextFromPdfiumGlyphs(read.glyphs, read.lang);
      if (options?.textOnly) return text;
      // The document's own fonts, so edits to existing text can be set in
      // them: fetched once per font, the first page that draws with it.
      const unseen = [...new Set(text.fontNames.values())].filter(
        (name) => !entry.faces.has(name) && !entry.rebuilt.has(name),
      );
      if (unseen.length > 0) {
        try {
          const fonts = decodeEmbeddedFonts(await core.pageFonts(entry.id, sourceIndex));
          await Promise.all(
            fonts.map(async (font) => {
              const family = await loadEmbeddedFontFace(font);
              if (family) entry.faces.set(font.name, family);
              else {
                entry.rebuilt.set(font.name, {
                  family: `shiori-pdf-${entry.id}-${entry.rebuilt.size}`,
                  asked: new Set(),
                  loaded: false,
                });
              }
            }),
          );
        } catch (error) {
          console.warn("PDFium could not read a page's fonts", error);
        }
        for (const name of unseen) {
          if (!entry.faces.has(name) && !entry.rebuilt.has(name)) entry.faces.set(name, null);
        }
        options?.checkAbort?.();
      }
      await rebuildFonts(entry, sourceIndex, read.glyphs);
      options?.checkAbort?.();
      for (const [style, name] of text.fontNames) {
        const rebuilt = entry.rebuilt.get(name);
        const family = rebuilt?.loaded ? rebuilt.family : entry.faces.get(name);
        if (family) text.faceFamilies.set(style, family);
      }
      return text;
    },

    security: (doc) => {
      const security = entryOf(doc).security;
      if (security === "unknown") throw new Error("PDFium could not report this document's security");
      return security ? { ...security } : null;
    },

    openEncryptedSource: async (bytes, password) => {
      let id: number;
      try {
        id = await core.open(bytes, password);
      } catch (error) {
        throw asError(error);
      }
      try {
        const security = securityOf(await core.security(id));
        if (!security) throw new Error("re-encryption unsupported: the source is not encrypted");
        let closed = false;
        return {
          security,
          plaintext: () => core.decryptedCopy(id).catch((error: unknown) => Promise.reject(asError(error))),
          encrypt: (plain) => core.encryptLikeSource(id, plain).catch((error: unknown) => Promise.reject(asError(error))),
          close: () => {
            if (closed) return;
            closed = true;
            core.close(id);
          },
        };
      } catch (error) {
        core.close(id);
        throw asError(error);
      }
    },

    destroy: async (doc) => {
      const entry = doc ? docs.get(doc) : undefined;
      if (!doc || !entry) return;
      docs.delete(doc);
      entry.closed = true;
      core.close(entry.id);
      for (const face of entry.rebuiltFaces) document.fonts.delete(face);
    },
  };
  return engine;
}

export const pdfiumDesktopEngine = createPdfiumEngine(
  {
    open: pdfCoreOpen,
    render: pdfCoreRender,
    cancel: pdfCoreCancel,
    close: pdfCoreClose,
    hideAnnotations: pdfCoreHideAnnotations,
    outline: pdfCoreOutline,
    links: pdfCoreLinks,
    pageText: pdfCorePageText,
    decryptedCopy: pdfCoreDecryptedCopy,
    pageGeometry: pdfCorePageGeometry,
    pageFonts: pdfCorePageFonts,
    fontOutlines: pdfCoreFontOutlines,
    security: pdfCoreSecurity,
    encryptLikeSource: pdfCoreEncryptLikeSource,
  },
);
