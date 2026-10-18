import { SOURCE_LINE_ATTR } from "./renderSafeHtml";

// A Markdown reading position is a source line, fractional: 12.5 is halfway
// through the block that starts on line 12 before the next one starts. The
// preview and the live editor lay the same text out at very different
// heights (rendered headings and code boxes against source lines), so a
// pixel offset carried across a mode switch landed in another section.

type Block = { el: HTMLElement; line: number };

function blocks(body: HTMLElement): Block[] {
  return [...body.querySelectorAll<HTMLElement>(`[${SOURCE_LINE_ATTR}]`)]
    .map((el) => ({ el, line: Number(el.getAttribute(SOURCE_LINE_ATTR)) }))
    .filter((block) => Number.isFinite(block.line));
}

/** The source line at the top of the preview's viewport, or null before it renders. */
export function previewSourceLine(scroller: HTMLElement, body: HTMLElement): number | null {
  const top = scroller.getBoundingClientRect().top;
  const all = blocks(body);
  for (let i = 0; i < all.length; i += 1) {
    const { el, line } = all[i]!;
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= top) continue;
    const next = all[i + 1]?.line ?? line + 1;
    const through = rect.height > 0 ? Math.min(Math.max((top - rect.top) / rect.height, 0), 1) : 0;
    return line + through * (next - line);
  }
  return all.length > 0 ? all[all.length - 1]!.line : null;
}

/** Scrolls the preview so `line` sits at the top; false before it renders. */
export function scrollPreviewToSourceLine(
  scroller: HTMLElement,
  body: HTMLElement,
  line: number,
): boolean {
  const all = blocks(body);
  if (all.length === 0) return false;
  let index = 0;
  while (index + 1 < all.length && all[index + 1]!.line <= line) index += 1;
  const { el, line: start } = all[index]!;
  const next = all[index + 1]?.line ?? start + 1;
  const through = Math.min(Math.max((line - start) / (next - start), 0), 1);
  const rect = el.getBoundingClientRect();
  scroller.scrollTop +=
    rect.top - scroller.getBoundingClientRect().top + through * rect.height;
  return true;
}
