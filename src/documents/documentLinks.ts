const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * What a click on a link inside a rendered document should do. "none" is a
 * link the viewer still cancels: its default action would navigate the app
 * window (Markdown renders in the app's own document) or the document frame.
 */
export type DocumentLinkAction =
  | { kind: "none" }
  | { kind: "external"; url: string };

/**
 * Every element a click can follow: HTML `<a>`, `<area>` in an image map,
 * and SVG `<a>`, whose target may be in `xlink:href` alone. Returns null when
 * the click is not on a link with a destination.
 */
export function documentLinkAction(target: Element): DocumentLinkAction | null {
  const link = target.closest("a, area");
  if (!link) return null;
  const raw = link.getAttribute("href") ?? link.getAttributeNS(XLINK_NS, "href");
  if (raw == null) return null;
  try {
    return { kind: "external", url: new URL(raw.trim(), link.baseURI).href };
  } catch {
    return { kind: "none" };
  }
}
