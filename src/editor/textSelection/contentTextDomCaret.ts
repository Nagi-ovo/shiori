// The caret of a click that opens a source-text edit, when the clicked block
// may already hold earlier edits that the new one absorbs. Inside such an
// edit the page shows its edited text, not the source glyphs under it, so the
// hit is read from where the written page paints that text (the text
// layer's engine glyphs, contentTextFrameCells) or, failing that, from the
// browser's layout of the edit's committed render, and carried through the
// absorption splice.
// Elsewhere it is read from the source geometry.
import type { AbsorbStep } from "./absorbText";
import { mapAbsorbedOffset } from "./absorbText";
import {
  canvasCaretMeasure,
  caretInLines,
  contentTextCaretOffset,
  graphemes,
  isRtlText,
  type CaretLine,
  type RunCaretCells,
} from "./contentTextCaret";
import type { DetectedLine } from "./paragraphDetect";
import { writtenCaretLines } from "./contentTextFrameCells";
import type { ContentTextOverlay, PageModel } from "../../pdf/model/types";
import type { PdfTextGlyph } from "../../pdf/engine/text";

type Point = { x: number; y: number };

export function openedEditCaret({ page, lines, point, scale, cellsOf, frame, absorbed, absorption, root }: {
  page: PageModel;
  lines: readonly DetectedLine[];
  point: Point;
  scale: number;
  cellsOf?: RunCaretCells;
  /** The text layer's geometry: the written page's engine glyphs per run. */
  frame?: { glyphs?: ReadonlyArray<readonly PdfTextGlyph[] | null> } | null;
  absorbed: readonly Pick<ContentTextOverlay, "id" | "text" | "rect" | "coverRects" | "fontSize">[];
  absorption: { steps: readonly AbsorbStep[] };
  root: HTMLElement | null;
}): number | null {
  const frameGlyphs = frame?.glyphs?.flatMap((run) => run ?? []) ?? [];
  if (root) {
    const origin = root.getBoundingClientRect();
    for (let step = 0; step < absorbed.length; step += 1) {
      const old = absorbed[step]!;
      if (!absorption.steps[step] || !old.text) continue;
      const group = root.ownerDocument.querySelector(`[role="group"][data-overlay-id=${JSON.stringify(old.id)}]`);
      // What the page paints for this edit; the CSS layout of its committed
      // render (what the textarea reproduces) only when no frame aligned.
      let layout = writtenCaretLines(old, page, scale, frameGlyphs);
      if (!layout && group?.firstElementChild) {
        const dom = domCaretLines(group.firstElementChild, origin);
        if (dom.text === old.text) layout = dom.lines;
      }
      if (!layout) continue;
      const box = group?.getBoundingClientRect();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      if (box && box.width > 0) {
        x0 = box.left - origin.left; x1 = box.right - origin.left; y0 = box.top - origin.top; y1 = box.bottom - origin.top;
      }
      for (const cell of layout.flatMap((l) => l.cells)) {
        x0 = Math.min(x0, cell.rect.x); x1 = Math.max(x1, cell.rect.x + cell.rect.w);
        y0 = Math.min(y0, cell.rect.y); y1 = Math.max(y1, cell.rect.y + cell.rect.h);
      }
      if (point.x < x0 || point.x > x1 || point.y < y0 || point.y > y1) continue;
      const offset = caretInLines(layout, point, old.text);
      if (offset !== null) return mapAbsorbedOffset(absorption, { step, offset });
    }
  }
  const offset = contentTextCaretOffset(lines, point, scale, canvasCaretMeasure, cellsOf);
  return offset === null ? null : mapAbsorbedOffset(absorption, { step: null, offset });
}

/** Grapheme cells of an element's laid-out text, relative to `origin`.
 * Hidden (visibility) renders still have layout; a newline starts a line. */
export function domCaretLines(element: Element, origin: { left: number; top: number }): { text: string; lines: CaretLine[] } {
  const nodes: Array<{ node: Text; start: number }> = [];
  let text = "";
  const walker = element.ownerDocument.createTreeWalker(element, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start: text.length });
    text += node.textContent ?? "";
  }
  const at = (offset: number): [Text, number] => {
    let i = nodes.length - 1;
    while (i > 0 && nodes[i]!.start > offset) i -= 1;
    const entry = nodes[i]!;
    return [entry.node, Math.min(offset - entry.start, entry.node.length)];
  };
  const lines: CaretLine[] = [{ top: Infinity, bottom: -Infinity, cells: [] }];
  const range = element.ownerDocument.createRange();
  for (const g of nodes.length ? graphemes(text) : []) {
    if (g.text === "\n") { lines.push({ top: Infinity, bottom: -Infinity, cells: [] }); continue; }
    range.setStart(...at(g.start));
    range.setEnd(...at(g.end));
    const rect = [...range.getClientRects()].find((r) => r.width > 0 || r.height > 0);
    if (!rect) continue;
    const line = lines.at(-1)!;
    const x = rect.left - origin.left, y = rect.top - origin.top;
    line.cells.push({ start: g.start, end: g.end, rect: { x, y, w: rect.width, h: rect.height },
      from: { x, y: y + rect.height }, to: { x: x + rect.width, y: y + rect.height }, rtl: isRtlText(g.text) });
    line.top = Math.min(line.top, y); line.bottom = Math.max(line.bottom, y + rect.height);
  }
  return { text, lines };
}
