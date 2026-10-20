// pdf.js keeps only these CSS properties of rich text (xhtml.js VALID_STYLES).
const RICH_TEXT_STYLES = new Set([
  "color", "font", "font-family", "font-size", "font-stretch", "font-style", "font-weight",
  "margin", "margin-bottom", "margin-left", "margin-right", "margin-top", "letter-spacing",
  "line-height", "orphans", "page-break-after", "page-break-before", "page-break-inside",
  "tab-interval", "tab-stop", "text-align", "text-decoration", "text-indent", "vertical-align",
  "widows", "kerning-mode",
]);

/**
 * The root style of /RC, the one part of pdf.js's rich-text tree the importer
 * reads. pdf.js has no font finder for annotation rich text, so it drops
 * `font-family` and keeps the `font` shorthand; so does this.
 */
export function richTextRoot(rc: string | undefined): { html: { attributes: { style: Record<string, string> } } } | null {
  if (!rc) return null;
  const body = rc.replace(/^\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*/i, "");
  const tag = /^<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/.exec(body);
  if (!tag) return null;
  const style: Record<string, string> = {};
  if (tag[2] === "body" || tag[2] === "xhtml") {
    const attribute = /(?:^|\s)style\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag[3] ?? "");
    const css = xmlUnescape(attribute?.[1] ?? attribute?.[2] ?? "");
    for (const declaration of css.split(";")) {
      const [rawKey, rawValue] = declaration.split(":", 2);
      const key = rawKey?.trim();
      if (!key || rawValue === undefined || !RICH_TEXT_STYLES.has(key) || key === "font-family") continue;
      style[key.replaceAll(/-([a-zA-Z])/g, (_, x: string) => x.toUpperCase())] = rawValue.trim();
    }
  }
  return { html: { attributes: { style } } };
}

function xmlUnescape(text: string): string {
  return text.replaceAll(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const code = entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return String.fromCodePoint(code);
  });
}
