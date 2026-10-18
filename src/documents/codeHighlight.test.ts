import "../test/setupDom";
import { afterEach, describe, expect, test } from "bun:test";
import { highlightCodeElement } from "./codeHighlight";
import { highlightCodeBlocksNearView } from "./highlightCodeBlocksNearView";

function codeBlock(language: string | null, text: string): HTMLElement {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  if (language) code.className = `language-${language}`;
  code.textContent = text;
  pre.append(code);
  document.body.append(pre);
  return code;
}

afterEach(() => {
  document.body.replaceChildren();
});

// A code block reads the same in the preview as in the live editor: the
// same language parsers, the same tok-* classes the shared colours target.
describe("preview code highlighting", () => {
  test("highlights a block in the language it names", async () => {
    const code = codeBlock("ts", "const answer: number = 42; // why");

    expect(await highlightCodeElement(code)).toBe(true);
    const token = (cls: string) => code.querySelector(`.${cls}`)?.textContent;
    expect(token("tok-keyword")).toBe("const");
    expect(token("tok-number")).toBe("42");
    expect(token("tok-comment")).toBe("// why");
    expect(code.textContent).toBe("const answer: number = 42; // why");
  });

  test("keeps markup in the code as text", async () => {
    const code = codeBlock("js", "const s = '<img src=x onerror=alert(1)>';");

    await highlightCodeElement(code);
    expect(code.querySelector("img")).toBeNull();
    expect(code.textContent).toBe("const s = '<img src=x onerror=alert(1)>';");
  });

  test("leaves a block in an unknown language, or none, as it was", async () => {
    const unknown = codeBlock("nosuchlanguage", "<b>x</b>");
    const bare = codeBlock(null, "plain");

    expect(await highlightCodeElement(unknown)).toBe(false);
    expect(await highlightCodeElement(bare)).toBe(false);
    expect(unknown.innerHTML).toBe("&lt;b&gt;x&lt;/b&gt;");
    expect(bare.innerHTML).toBe("plain");
  });

  // Highlighting a whole long document before showing it took ten times
  // as long; blocks far down the page wait until they come near.
  test("highlights only the blocks that come near the viewport", async () => {
    const observed = new Map<Element, (visible: boolean) => void>();
    const previous = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        observed.set(target, (visible) =>
          this.callback(
            [{ target, isIntersecting: visible } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        );
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    } as unknown as typeof IntersectionObserver;
    try {
      const near = codeBlock("ts", "const near = 1;");
      const far = codeBlock("ts", "const far = 2;");
      const stop = highlightCodeBlocksNearView(document.body);

      observed.get(near)!(true);
      await waitUntil(() => near.querySelector(".tok-keyword") !== null);
      expect(far.querySelector(".tok-keyword")).toBeNull();

      observed.get(far)!(true);
      await waitUntil(() => far.querySelector(".tok-keyword") !== null);
      stop();
      expect(observed.size).toBe(0);
    } finally {
      globalThis.IntersectionObserver = previous;
    }
  });
});

async function waitUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(done()).toBe(true);
}
