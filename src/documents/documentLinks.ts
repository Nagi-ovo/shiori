const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * What a click on a link inside a rendered document should do. "none" is a
 * link the viewer still cancels: its default action would navigate the app
 * window (Markdown renders in the app's own document) or the document frame.
 */
export type DocumentLinkAction =
  | { kind: "none" }
  | { kind: "external"; url: string }
  | { kind: "fragment"; target: Element | null };

/**
 * Handles a click inside a rendered document. Any link with a destination is
 * cancelled; an in-page fragment ("#ch2") scrolls to its target inside
 * `scope` (its resolved URL is the app's, not the document's), and every
 * other destination goes to `openExternal`.
 */
export function followDocumentLink(
  event: { target: EventTarget | null; preventDefault(): void },
  scope: ParentNode,
  openExternal: (url: string) => void,
): void {
  const action = documentLinkAction(event.target, scope);
  if (!action) return;
  event.preventDefault();
  if (action.kind === "fragment") action.target?.scrollIntoView();
  else if (action.kind === "external") openExternal(action.url);
}

/**
 * Every element a click can follow: HTML `<a>`, `<area>` in an image map,
 * and SVG `<a>`, whose target may be in `xlink:href` alone. Returns null when
 * the click is not on a link with a destination.
 */
export function documentLinkAction(
  target: EventTarget | null,
  scope: ParentNode,
): DocumentLinkAction | null {
  const link = asElement(target)?.closest("a, area");
  if (!link) return null;
  const raw = link.getAttribute("href") ?? link.getAttributeNS(XLINK_NS, "href");
  if (raw == null) return null;
  const href = raw.trim();
  if (href.startsWith("#")) {
    return { kind: "fragment", target: fragmentTarget(scope, href.slice(1)) };
  }
  try {
    return { kind: "external", url: new URL(href, link.baseURI).href };
  } catch {
    return { kind: "none" };
  }
}

// Not `instanceof Element`: a click in the HTML document frame comes from the
// frame's own realm, whose Element is not the app's.
function asElement(target: EventTarget | null): Element | null {
  const node = target as Element | null;
  return node?.nodeType === 1 && typeof node.closest === "function" ? node : null;
}

// The HTML rule for a fragment: the first element with that id, else the
// first <a> with that name.
function fragmentTarget(scope: ParentNode, fragment: string): Element | null {
  let id = fragment;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    // A malformed escape is matched as written.
  }
  if (!id) return null;
  const candidates = Array.from(scope.querySelectorAll("[id], a[name]"));
  return (
    candidates.find((element) => element.id === id) ??
    candidates.find(
      (element) => element.localName === "a" && element.getAttribute("name") === id,
    ) ??
    null
  );
}
