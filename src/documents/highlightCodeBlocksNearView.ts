/** The element `node` scrolls in, or null for the page itself. */
function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === "auto" || overflow === "scroll") return el;
  }
  return null;
}

/**
 * Highlights the code blocks under `root` as they come within a screen of the
 * viewport they scroll in, each once. The highlighter (and each language)
 * loads on the first block that needs it. Returns the teardown.
 *
 * The scroll container is found from the DOM rather than passed in: the
 * viewer's shared scroller ref is re-pointed by the editor as it unmounts,
 * after the preview has mounted, and an observer rooted on a stale element
 * never fires.
 */
export function highlightCodeBlocksNearView(root: HTMLElement): () => void {
  const blocks = root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]');
  if (blocks.length === 0) return () => undefined;
  const highlight = (code: HTMLElement) => {
    void import("./codeHighlight")
      .then(({ highlightCodeElement }) => highlightCodeElement(code))
      .catch((error: unknown) => console.warn("Could not highlight a code block", error));
  };
  if (typeof IntersectionObserver === "undefined") {
    blocks.forEach(highlight);
    return () => undefined;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        highlight(entry.target as HTMLElement);
      }
    },
    { root: scrollParent(root), rootMargin: "100% 0px" },
  );
  blocks.forEach((code) => observer.observe(code));
  return () => observer.disconnect();
}
