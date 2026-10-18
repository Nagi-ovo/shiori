// The small pieces of changelog markdown syntax that every reader of
// docs/changelog/*.md must agree on: the app's renderer
// (src/editor/components/markdownBlocks.ts), the website's parser
// (site/src/content/changelog.ts) and the release-notes flattening
// (src/release/notes.ts). Each used to carry its own copy, and the copies
// had already drifted. Pure and dependency-free, since the website and
// Node scripts import it too.

// Han, kana, CJK punctuation and fullwidth forms — the scripts that
// carry no word space of their own.
export const CJK =
  /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]/;

/**
 * Join a soft-wrapped line (or a bold lead's tail) onto the text it
 * continues. Markdown collapses the newline to a space, which is right for
 * Latin and wrong for CJK: the zh and ja changelogs wrap mid-sentence, and
 * a space there opens a visible hole between two characters that belong
 * together. Only a CJK/CJK boundary loses the space; a CJK/Latin one keeps
 * it, because that is a real word boundary. Nor does a space go before
 * closing punctuation: "**…work**, as" reads "work, as".
 */
export function joinWrapped(text: string, next: string): string {
  const continuation = next.trim();
  if (!text) return continuation;
  if (!continuation) return text;
  if (/^[,.;:!?)\]]/.test(continuation)) return `${text}${continuation}`;
  return CJK.test(text[text.length - 1]!) && CJK.test(continuation[0]!)
    ? `${text}${continuation}`
    : `${text} ${continuation}`;
}

// A GFM table: a pipe row, a delimiter row (`|---|:--:|`), then pipe rows.
export const TABLE_ROW = /^\s*\|.*\|\s*$/;
export const TABLE_DELIMITER = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;

export type CellAlign = "left" | "center" | "right" | null;

/** `| a | b |` → ["a", "b"]. */
export function tableCells(line: string): string[] {
  return line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
}

/** Per column, from the colons in a delimiter row. */
export function tableAlign(delimiter: string): CellAlign[] {
  return tableCells(delimiter).map((cell) =>
    cell.startsWith(":") && cell.endsWith(":")
      ? "center"
      : cell.endsWith(":")
        ? "right"
        : cell.startsWith(":")
          ? "left"
          : null,
  );
}
