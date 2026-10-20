import { PDFDict, PDFName, type PDFPage } from "pdf-lib";
import type { ContentTextOverlay, Overlay } from "../model/types";
import { redactCoveredTextOnPage } from "./contentStreamEdit/redactCoveredText";

// Per-contentText-overlay outcome of the glyph-removal pass, keyed by
// overlay id. cleanRects (by coverRect index): the rect was provably fully
// redacted, so its background cover fill can be skipped. sourceFont: the
// single source /Font resource all removed glyphs were shown with, when the
// replacement text can try to reuse it (null = unknown or mixed → bundled
// fonts).
export type SourceFontRef = { name: string; dict: PDFDict };
export type ContentTextRedaction = Map<
  string,
  { cleanRects: boolean[]; sourceFont: SourceFontRef | null }
>;

export function redactContentTextCoverRects(
  out: PDFPage,
  pageOverlays: Overlay[],
): ContentTextRedaction {
  const redactionByOverlay: ContentTextRedaction = new Map();
  const fontVotesByOverlay = new Map<string, Map<string, number>>();
  const coverRects: ContentTextOverlay["coverRects"] = [];
  const rectOwners: Array<{ overlayId: string; rectIndex: number }> = [];

  for (const overlay of pageOverlays) {
    if (overlay.type !== "contentText") continue;
    redactionByOverlay.set(overlay.id, {
      cleanRects: Array.from(
        { length: overlay.coverRects.length },
        () => false,
      ),
      sourceFont: null,
    });
    fontVotesByOverlay.set(overlay.id, new Map());
    for (let rectIndex = 0; rectIndex < overlay.coverRects.length; rectIndex += 1) {
      coverRects.push(overlay.coverRects[rectIndex]!);
      rectOwners.push({ overlayId: overlay.id, rectIndex });
    }
  }

  const report = redactCoveredTextOnPage(out, coverRects);
  for (let index = 0; index < rectOwners.length; index += 1) {
    const owner = rectOwners[index]!;
    const redaction = redactionByOverlay.get(owner.overlayId);
    if (!redaction) continue;
    redaction.cleanRects[owner.rectIndex] = report.cleanRects[index] ?? false;

    // Tally per-rect font attributions into ONE replacement font per
    // overlay, by majority. A rect that mixes fonts (an inline italic word,
    // a math symbol) or attributes to a minority font doesn't veto the
    // overlay: the replacement is drawn in a single flattened style anyway
    // — matching the on-screen edit box — and the encoder still verifies
    // every character against the chosen font before it is used. Mixed and
    // empty rects simply don't vote.
    const attribution = report.rectFonts[index] ?? { kind: "none" };
    if (attribution.kind === "font") {
      const votes = fontVotesByOverlay.get(owner.overlayId);
      if (votes) {
        votes.set(attribution.name, (votes.get(attribution.name) ?? 0) + 1);
      }
    }
  }

  const fontDict = out.node
    .Resources()
    ?.lookupMaybe(PDFName.of("Font"), PDFDict);
  for (const [overlayId, votes] of fontVotesByOverlay) {
    let best: string | null = null;
    let bestCount = 0;
    let tied = false;
    for (const [name, count] of votes) {
      if (count > bestCount) {
        best = name;
        bestCount = count;
        tied = false;
      } else if (count === bestCount) {
        tied = true;
      }
    }
    // An exact tie has no dominant font — stay on the bundled-font path.
    if (!best || tied) continue;
    const dict = fontDict?.lookupMaybe(PDFName.of(best), PDFDict);
    if (!dict) continue;
    redactionByOverlay.get(overlayId)!.sourceFont = { name: best, dict };
  }
  return redactionByOverlay;
}

// Edits with at least one cover rect the pass could not prove clean: some of
// their source glyphs are still in the page content, merely painted over.
export function unexcisedEditCount(redaction: ContentTextRedaction): number {
  let count = 0;
  for (const { cleanRects } of redaction.values()) {
    if (cleanRects.some((clean) => !clean)) count += 1;
  }
  return count;
}
