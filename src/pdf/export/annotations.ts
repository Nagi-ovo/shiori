// Builds real PDF /Annot dictionaries for our overlay model and attaches
// them to pages, so exported documents remain editable in Acrobat, Foxit,
// PDF Expert, and our own reader. Parallel path to the flatten-into-page
// code in exportPdf.ts — both live side-by-side because some export
// workflows (stamping, signing) intentionally want flattened content.

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import type { Font as FontkitFont } from "@pdf-lib/fontkit";
import type { Overlay, PageModel } from "../model/types";
import { isListedForImport } from "../import/sourceAnnotations";
import {
  SHIORI_FONT_PREFIXES,
  pickFreeTextFont,
  type AnnotationFonts,
  type FreeTextFontEntry,
  type FreeTextFontNames,
} from "./annotationFonts";
import {
  SHIORI_ANNOT_PREFIX,
  decodePdfText,
  formatPdfDate,
} from "./annotationShared";
import { buildCallout, buildCalloutReply } from "./calloutAnnotations";
import { buildFreeText, buildStampFreeText } from "./freeTextAnnotations";
import {
  markKeptAnnotationLinks,
  relinkKeptReplies,
  takeKeptAnnotationLinks,
  type RemovedAnnotation,
} from "./keptAnnotationLinks";
import {
  buildHighlight,
  buildInk,
  buildSquare,
  buildStickyNote,
  buildStrikeOut,
  buildUnderline,
} from "./markupAnnotations";

export type { AnnotationFonts } from "./annotationFonts";

const REPLACED_SOURCE_SUBTYPES = new Set([
  "FreeText",
  "Highlight",
  "Ink",
  "Square",
  "Text",
  "StrikeOut",
  "Underline",
]);

/** Remove every page annotation, including links, widgets, and unknown types. */
export function stripAllAnnotationsFromPages(pages: PDFPage[]): boolean {
  let removed = false;
  for (const page of pages) {
    if (!page.node.get(PDFName.of("Annots"))) continue;
    page.node.delete(PDFName.of("Annots"));
    removed = true;
  }
  return removed;
}

// `pages` is the source document's page list, so an index is a sourceIndex.
export function stripReplaceableAnnotationsFromPages(pages: PDFPage[]): boolean {
  let removedAny = false;
  const removed = new Map<string, RemovedAnnotation>();
  pages.forEach((page, sourceIndex) => {
    removedAny = stripReplaceableAnnotationsFromPage(page, sourceIndex, removed) || removedAny;
  });
  // After every page: a link may cross pages.
  if (removed.size > 0) {
    pages.forEach((page, sourceIndex) => markKeptAnnotationLinks(page, sourceIndex, removed));
  }
  return removedAny;
}

// Main entry: build annotation refs for the overlays on `page` and attach
// them to its /Annots array. Handles per-page font registration for
// FreeText so the DA string's font operator resolves against the page's
// /Resources /Font dict.
export function attachAnnotationsToPage(
  page: PDFPage,
  model: PageModel,
  overlays: Overlay[],
  fonts: AnnotationFonts,
): void {
  // Before the early return: strip's marks must leave every copied page.
  const kept = takeKeptAnnotationLinks(page);
  const pageOverlays = overlays.filter((o) => o.pageId === model.id);
  if (pageOverlays.length === 0) return;

  // Cache font-dict names once per page, only if a FreeText shows up.
  // The ASCII fonts cover every family × weight combination because
  // the editable-mode DA string needs a single resolved /Font name
  // per annotation — picking at buildAnnotRef time requires all six
  // to be registered up front.
  let freeTextFontNames: FreeTextFontNames | null = null;
  const ensureFontNames = (): FreeTextFontNames => {
    if (freeTextFontNames) return freeTextFontNames;
    const reg = (
      alias: string,
      font: PDFFont,
      pathFont?: FontkitFont | null,
    ): FreeTextFontEntry => ({
      name: page.node.newFontDictionary(alias, font.ref),
      font,
      pathFont,
    });
    freeTextFontNames = {
      helv: reg("SHelv", fonts.helv),
      helvBold: reg("SHelvB", fonts.helvBold),
      helvOblique: reg("SHelvO", fonts.helvOblique),
      helvBoldOblique: reg("SHelvBO", fonts.helvBoldOblique),
      times: reg("STimes", fonts.times),
      timesBold: reg("STimesB", fonts.timesBold),
      timesItalic: reg("STimesI", fonts.timesItalic),
      timesBoldItalic: reg("STimesBI", fonts.timesBoldItalic),
      courier: reg("SCour", fonts.courier),
      courierBold: reg("SCourB", fonts.courierBold),
      courierOblique: reg("SCourO", fonts.courierOblique),
      courierBoldOblique: reg("SCourBO", fonts.courierBoldOblique),
      zapf: reg("SZapf", fonts.zapf),
      unicode: fonts.unicode
        ? reg("SUni", fonts.unicode, fonts.unicodePath)
        : null,
      unicodePath: fonts.unicodePath,
      unicodeJp: fonts.unicodeJp
        ? reg("SUniJP", fonts.unicodeJp, fonts.unicodeJpPath)
        : null,
      unicodeJpPath: fonts.unicodeJpPath,
    };
    return freeTextFontNames;
  };

  const refsByOverlayId = new Map<string, PDFRef>();
  for (const o of pageOverlays) {
    const ref = buildAnnotRef(page, o, ensureFontNames);
    if (!ref) continue;
    page.node.addAnnot(ref);
    refsByOverlayId.set(o.id, ref);
    applySourceProvenance(page, o, ref);
  }
  // /IRT has to wait until every annotation on the page has a ref, because a
  // reply may be built before the comment it answers. Threads that span pages
  // are not rebuilt: /IRT is defined within a page's annotation list.
  linkReplyThreads(page, pageOverlays, refsByOverlayId, kept.parents);
  relinkKeptReplies(kept.replies, refsByOverlayId);
  // Callout conversation turns become native /IRT Text replies, appended in
  // thread order so a round trip reads them back in the same order.
  for (const o of pageOverlays) {
    if (o.type !== "callout" || !o.thread?.length) continue;
    const parentRef = refsByOverlayId.get(o.id);
    if (!parentRef) continue;
    for (const entry of o.thread) {
      page.node.addAnnot(buildCalloutReply(page, o, entry, parentRef));
    }
  }
}

// Writes back the review metadata captured at import (see OverlayCommon's
// source* fields). Overlays authored in Shiori carry none of these, so their
// annotations stay exactly as before — no invented author, no invented date.
function applySourceProvenance(page: PDFPage, o: Overlay, ref: PDFRef): void {
  const dict = page.doc.context.lookupMaybe(ref, PDFDict);
  if (!dict) return;
  if (o.sourceAuthor) {
    dict.set(PDFName.of("T"), PDFHexString.fromText(o.sourceAuthor));
  }
  // Every builder writes Print; a source annotation that was hidden, locked
  // or never printed keeps what it was.
  const flags = o.sourceFlags;
  if (typeof flags === "number" && Number.isInteger(flags) && flags >= 0) {
    dict.set(PDFName.of("F"), PDFNumber.of(flags));
  }
  if (typeof o.sourceCreatedAt === "number") {
    const value = formatPdfDate(o.sourceCreatedAt);
    if (value) dict.set(PDFName.of("CreationDate"), PDFString.of(value));
  }
  if (typeof o.sourceModifiedAt === "number") {
    const value = formatPdfDate(o.sourceModifiedAt);
    if (value) dict.set(PDFName.of("M"), PDFString.of(value));
  }
}

// A reply's parent is either rebuilt here too or a kept annotation Shiori
// does not import (keptParents, see ./keptAnnotationLinks).
function linkReplyThreads(
  page: PDFPage,
  overlays: Overlay[],
  refsByOverlayId: Map<string, PDFRef>,
  keptParents: Map<string, PDFRef>,
): void {
  for (const o of overlays) {
    if (!o.sourceInReplyToId) continue;
    const parentRef =
      refsByOverlayId.get(o.sourceInReplyToId) ?? keptParents.get(o.sourceInReplyToId);
    if (!parentRef) continue;
    const ownRef = refsByOverlayId.get(o.id);
    if (!ownRef) continue;
    const dict = page.doc.context.lookupMaybe(ownRef, PDFDict);
    if (!dict) continue;
    dict.set(PDFName.of("IRT"), parentRef);
    dict.set(PDFName.of("RT"), PDFName.of(o.sourceReplyType ?? "R"));
  }
}

function buildAnnotRef(
  page: PDFPage,
  o: Overlay,
  ensureFontNames: () => FreeTextFontNames,
): PDFRef | null {
  const ctx = page.doc.context;
  if (o.type === "highlight") return buildHighlight(page, o);
  if (o.type === "underline") return buildUnderline(page, o);
  if (o.type === "strikethrough") return buildStrikeOut(page, o);
  if (o.type === "note") return buildStickyNote(page, o);
  if (o.type === "rect") return buildSquare(page, o);
  if (o.type === "stamp") return buildStampFreeText(page, o, ensureFontNames().zapf.name);
  if (o.type === "ink") return buildInk(page, o);
  if (o.type === "text") {
    const picked = pickFreeTextFont(
      o.fontFamily,
      o.bold,
      Boolean(o.italic),
      o.text,
      ensureFontNames(),
    );
    return buildFreeText(page, o, picked);
  }
  if (o.type === "callout") {
    const picked = pickFreeTextFont(
      o.fontFamily,
      o.bold,
      Boolean(o.italic),
      o.text,
      ensureFontNames(),
    );
    return buildCallout(page, o, picked);
  }
  void ctx;
  return null;
}

function stripReplaceableAnnotationsFromPage(
  page: PDFPage,
  sourceIndex: number,
  removed: Map<string, RemovedAnnotation>,
): boolean {
  const annots = page.node.Annots();
  if (!annots) return false;

  let removedAny = false;
  const removedRefs = new Set<string>();
  for (let i = annots.size() - 1; i >= 0; i--) {
    const raw = annots.get(i);
    const dict = annots.lookupMaybe(i, PDFDict);
    if (!dict) continue;
    if (!isReplaceableAnnotation(dict)) continue;
    annots.remove(i);
    removedAny = true;
    if (raw instanceof PDFRef) {
      removedRefs.add(raw.toString());
      const irt = dict.get(PDFName.of("IRT"));
      removed.set(raw.toString(), { sourceIndex, inReplyTo: irt instanceof PDFRef ? irt : null });
      page.doc.context.delete(raw);
    }
  }
  // A /Popup is the pop-up window OF a markup annotation and points at it via
  // /Parent. Popups are not in REPLACED_SOURCE_SUBTYPES, so removing a Text or
  // Highlight used to leave its popup behind holding a reference to an object
  // that no longer exists.
  if (removedAny) removeOrphanedPopups(page, annots, removedRefs);
  if (removedAny) stripShioriFontResources(page);
  return removedAny;
}

function removeOrphanedPopups(
  page: PDFPage,
  annots: PDFArray,
  removedRefs: Set<string>,
): void {
  for (let i = annots.size() - 1; i >= 0; i--) {
    const raw = annots.get(i);
    const dict = annots.lookupMaybe(i, PDFDict);
    if (!dict) continue;
    const subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();
    if (subtype !== "Popup") continue;
    const parent = dict.get(PDFName.of("Parent"));
    if (!(parent instanceof PDFRef)) continue;
    if (!removedRefs.has(parent.toString())) continue;
    annots.remove(i);
    if (raw instanceof PDFRef) page.doc.context.delete(raw);
  }
}

function isReplaceableAnnotation(dict: PDFDict): boolean {
  const name = decodePdfText(dict.lookupMaybe(PDFName.of("NM"), PDFString, PDFHexString));
  // Written by Shiori: always ours to replace, whatever its current state.
  if (name.startsWith(SHIORI_ANNOT_PREFIX)) return true;
  const subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();
  if (!subtype || !REPLACED_SOURCE_SUBTYPES.has(subtype)) return false;
  // Matching subtype is not enough. Removal is only safe for annotations the
  // editor actually took ownership of, and it only ever saw the ones the
  // importer's listing handed over. Anything it filtered out never became an
  // overlay, and is not re-added on export — so removing it would delete it
  // from the user's file permanently, with no undo (the overlay model never
  // held it). Deliberately NOT keyed on "is it in the model right now":
  // deleting an imported annotation removes it from the model, and that
  // deletion still has to reach the file.
  // Only what the importer was handed became an overlay; the listing's
  // display filter (ported from pdf.js, ../import/sourceAnnotations) decides.
  return isListedForImport(dict, subtype);
}

function stripShioriFontResources(page: PDFPage): void {
  const resources = page.node.Resources();
  const fonts = resources?.lookupMaybe(PDFName.Font, PDFDict);
  if (!fonts) return;
  for (const key of fonts.keys()) {
    const name = key.decodeText();
    if (SHIORI_FONT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      fonts.delete(key);
    }
  }
}
