import "../../test/setupDom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import type { DocumentViewer as DocumentViewerComponent } from "./DocumentViewer";

let DocumentViewer: typeof DocumentViewerComponent;

describe("DocumentViewer rendering", () => {
  beforeAll(async () => {
    DocumentViewer = (await import("./DocumentViewer")).DocumentViewer;
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  test("keeps rendered HTML after the async renderer resolves", async () => {
    const view = render(
      <DocumentViewer
        kind="markdown"
        title="sample.md"
        text="# Rendered document"
        scrollTop={0}
        onScrollTopChange={() => undefined}
        renderHtml={async () => "<h1>Rendered document</h1>"}
      />,
    );

    await waitFor(() => {
      expect(view.getByText("Rendered document")).toBeTruthy();
    });
    await new Promise((resolve) => window.setTimeout(resolve, 8));

    expect(view.getByText("Rendered document")).toBeTruthy();
  });

  test("applies body, code, and layout choices to Markdown preview", async () => {
    const view = render(
      <DocumentViewer
        kind="markdown"
        title="styled.md"
        text="Body and `code`"
        scrollTop={0}
        onScrollTopChange={() => undefined}
        markdownAppearance={{
          bodyFont: { source: "system", family: "Avenir Next" },
          codeFont: { source: "system", family: "Cascadia Code" },
          headingColor: "#2d5a3d",
          fontSize: 18,
          lineHeight: 1.8,
          contentWidth: 720,
        }}
        markdownHeadingColor="#2d5a3d"
        renderHtml={async () => "<p>Body and <code>code</code></p>"}
      />,
    );

    await view.findByText("Body and", { exact: false });
    const article = view.container.querySelector(
      ".shioriDocumentViewer",
    ) as HTMLElement;
    expect(article.style.fontFamily).toContain("Avenir Next");
    expect(article.style.fontSize).toBe("18px");
    expect(article.style.lineHeight).toBe("1.8");
    expect(article.style.maxWidth).toBe("720px");
    expect(
      article.style.getPropertyValue("--shiori-markdown-code-font"),
    ).toContain("Cascadia Code");
    expect(
      article.style.getPropertyValue("--shiori-markdown-heading-color"),
    ).toBe("#2d5a3d");
  });

  // React 19 compares dangerouslySetInnerHTML by identity, so an inline
  // object rewrote the preview on every re-render: highlighting and
  // selection gone, megabytes of HTML reparsed.
  test("keeps the preview and its code highlighting across a re-render", async () => {
    const previous = globalThis.IntersectionObserver;
    // Without an observer every block highlights at once.
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    try {
      const props = {
        kind: "markdown" as const,
        title: "code.md",
        text: "```ts\nconst a = 1;\n```",
        scrollTop: 0,
        onScrollTopChange: () => undefined,
        renderHtml: async () => '<pre><code class="language-ts">const a = 1;</code></pre>',
      };
      const view = render(<DocumentViewer {...props} zoom={1} />);
      await waitFor(() => {
        expect(view.container.querySelector("code .tok-keyword")).toBeTruthy();
      });
      const code = view.container.querySelector("code");

      view.rerender(<DocumentViewer {...props} zoom={1.1} />);

      expect(view.container.querySelector("code")).toBe(code);
      expect(view.container.querySelector("code .tok-keyword")?.textContent).toBe("const");
    } finally {
      globalThis.IntersectionObserver = previous;
    }
  });

  test("highlights the preview's code again after returning from the editor", async () => {
    const previous = globalThis.IntersectionObserver;
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    try {
      const props = {
        kind: "markdown" as const,
        title: "code.md",
        text: "```ts\nconst a = 1;\n```",
        scrollTop: 0,
        onScrollTopChange: () => undefined,
        onMarkdownModeChange: () => undefined,
        renderHtml: async () => '<pre><code class="language-ts">const a = 1;</code></pre>',
      };
      const view = render(<DocumentViewer {...props} markdownMode="preview" />);
      await waitFor(() => {
        expect(view.container.querySelector("pre code .tok-keyword")).toBeTruthy();
      });

      view.rerender(<DocumentViewer {...props} markdownMode="edit" />);
      view.rerender(<DocumentViewer {...props} markdownMode="preview" />);

      await waitFor(() => {
        expect(view.container.querySelector("pre code .tok-keyword")?.textContent).toBe("const");
      });
    } finally {
      globalThis.IntersectionObserver = previous;
    }
  });

  test("renders HTML documents in an isolated frame", async () => {
    const view = render(
      <DocumentViewer
        kind="html"
        title="sample.html"
        text="<h1>Raw document</h1>"
        scrollTop={0}
        onScrollTopChange={() => undefined}
        renderHtml={async () =>
          '<!doctype html><html><head><style>.hero { color: red }</style></head><body><h1 class="hero">Raw document</h1></body></html>'
        }
      />,
    );

    const iframe = await view.findByTitle("sample.html");

    expect(iframe).toBeInstanceOf(window.HTMLIFrameElement);
    expect(iframe.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(iframe.getAttribute("srcdoc")).toContain(
      "<style>.hero { color: red }</style>",
    );
    expect(view.container.querySelector(".shioriDocumentViewer")).toBeNull();
  });

  test("lets a tall HTML frame own native scrolling and reports its position", async () => {
    const scrollPositions: number[] = [];
    const view = render(
      <DocumentViewer
        kind="html"
        title="tall.html"
        text="<main>Tall document</main>"
        scrollTop={0}
        zoom={1.2}
        onScrollTopChange={(scrollTop) => scrollPositions.push(scrollTop)}
        renderHtml={async () =>
          "<!doctype html><html><body><main>Tall document</main></body></html>"
        }
      />,
    );

    const iframe = (await view.findByTitle("tall.html")) as HTMLIFrameElement;
    fireEvent.load(iframe);
    await waitFor(() => {
      expect(
        iframe.contentDocument?.documentElement.style.getPropertyValue("zoom"),
      ).toBe("1.2");
    });

    const shell = view.container.querySelector(
      ".shioriHtmlFrameShell",
    ) as HTMLDivElement;
    expect(shell.style.overflow).toBe("hidden");
    expect(iframe.style.height).toBe("100%");

    const frameScroller = iframe.contentDocument?.scrollingElement as HTMLElement;
    frameScroller.scrollTop = 240;
    iframe.contentWindow?.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(scrollPositions).toContain(240));
  });

  test("a pinch keeps its baseline when the zoom prop changes mid-gesture", async () => {
    // Regression: the listener effect depended on `zoom`, so every zoom step
    // it produced tore itself down and reinstalled. Teardown cleared the
    // gesture baseline, so the next scale multiplied against the zoom it had
    // already applied instead of the zoom the pinch started at — trackpad
    // zoom compounded to the clamp within a few frames, and the touch path
    // lost its pointer map and froze after one step.
    const zooms: number[] = [];
    let zoom = 1;
    const viewer = () => (
      <DocumentViewer
        kind="html"
        title="pinch.html"
        text="<main>Pinch</main>"
        scrollTop={0}
        zoom={zoom}
        onZoomChange={(next) => {
          zooms.push(next);
          zoom = next;
        }}
        onScrollTopChange={() => undefined}
        renderHtml={async () =>
          "<!doctype html><html><body><main>Pinch</main></body></html>"
        }
      />
    );
    const view = render(viewer());
    const iframe = (await view.findByTitle("pinch.html")) as HTMLIFrameElement;
    fireEvent.load(iframe);
    const doc = iframe.contentDocument;
    if (!doc) throw new Error("iframe has no document");
    await waitFor(() => {
      expect(doc.documentElement.style.touchAction).toBe("pan-x pan-y");
    });

    const touch = (type: string, id: number, x: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, {
        pointerId: id,
        pointerType: "touch",
        clientX: x,
        clientY: 0,
      });
      doc.dispatchEvent(event);
    };

    // Two fingers 100px apart: the pinch baseline is zoom 1.
    touch("pointerdown", 1, 0);
    touch("pointerdown", 2, 100);
    // Spread to 150px — scale 1.5 against the baseline.
    touch("pointermove", 2, 150);
    await waitFor(() => expect(zooms.length).toBe(1));
    expect(zooms[0]).toBeCloseTo(1.5, 3);

    // The parent applies the new zoom while the fingers are still down.
    view.rerender(viewer());

    // Spread to 200px — scale 2 against the SAME baseline, so 2, not 1.5 x 2.
    touch("pointermove", 2, 200);
    await waitFor(() => expect(zooms.length).toBe(2));
    expect(zooms[1]).toBeCloseTo(2, 3);
  });

  test("a frame reload drops the fingers the old document still thinks are down", async () => {
    // The iframe is keyed on refreshKey, so a reload swaps the element out.
    // The old document never sends pointerup, and pinch state lives in refs,
    // so stale pointers would survive into the new frame — two phantom
    // fingers are enough to make every later pointermove bail on
    // "size !== 2" and freeze pinch entirely.
    const zooms: number[] = [];
    let zoom = 1;
    const viewer = () => (
      <DocumentViewer
        kind="html"
        title="reload.html"
        text="<main>Reload</main>"
        scrollTop={0}
        zoom={zoom}
        onZoomChange={(next) => {
          zooms.push(next);
          zoom = next;
        }}
        onScrollTopChange={() => undefined}
        renderHtml={async () =>
          "<!doctype html><html><body><main>Reload</main></body></html>"
        }
      />
    );
    const view = render(viewer());

    const touchOn = (
      doc: Document,
      type: string,
      id: number,
      x: number,
    ) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, {
        pointerId: id,
        pointerType: "touch",
        clientX: x,
        clientY: 0,
      });
      doc.dispatchEvent(event);
    };

    const firstFrame = (await view.findByTitle(
      "reload.html",
    )) as HTMLIFrameElement;
    fireEvent.load(firstFrame);
    const firstDoc = firstFrame.contentDocument;
    if (!firstDoc) throw new Error("no first document");
    await waitFor(() => {
      expect(firstDoc.documentElement.style.touchAction).toBe("pan-x pan-y");
    });

    // Two fingers go down and never come up — the frame reloads under them.
    touchOn(firstDoc, "pointerdown", 1, 0);
    touchOn(firstDoc, "pointerdown", 2, 100);

    // The real reload path: DocumentViewer owns refreshKey and bumps it from
    // the frame's own refresh control, so drive that rather than a prop.
    fireEvent.click(view.getByTitle("Refresh preview"));
    const secondFrame = (await view.findByTitle(
      "reload.html",
    )) as HTMLIFrameElement;
    fireEvent.load(secondFrame);
    const secondDoc = secondFrame.contentDocument;
    if (!secondDoc) throw new Error("no second document");
    await waitFor(() => {
      expect(secondDoc.documentElement.style.touchAction).toBe("pan-x pan-y");
    });

    // A fresh pinch in the new frame, with pointer ids the old one never used.
    touchOn(secondDoc, "pointerdown", 3, 0);
    touchOn(secondDoc, "pointerdown", 4, 100);
    touchOn(secondDoc, "pointermove", 4, 150);

    await waitFor(() => expect(zooms.length).toBe(1));
    expect(zooms[0]).toBeCloseTo(1.5, 3);
  });

  test("uses on-accent text on solid accent actions", async () => {
    const view = render(
      <DocumentViewer
        kind="markdown"
        title="remote.md"
        text="![Remote](https://example.com/image.png)"
        scrollTop={0}
        onScrollTopChange={() => undefined}
        renderHtml={async () =>
          '<p><img src="https://example.com/image.png" alt="Remote"></p>'
        }
      />,
    );

    const action = await view.findByRole("button", {
      name: "Load remote images",
    });
    expect((action as HTMLElement).style.background).toBe("var(--opx-accent)");
    expect((action as HTMLElement).style.color).toBe("var(--opx-onAccent)");
  });

  test("edits markdown without rendering preview work", async () => {
    let renderCalls = 0;
    const view = render(
      <DocumentViewer
        kind="markdown"
        title="sample.md"
        text="# Draft"
        scrollTop={0}
        onScrollTopChange={() => undefined}
        markdownMode="edit"
        onMarkdownModeChange={() => undefined}
        onMarkdownTextChange={() => undefined}
        renderHtml={async () => {
          renderCalls += 1;
          return "<h1>Draft</h1>";
        }}
      />,
    );

    const editor = (await view.findByLabelText("Markdown editor")) as HTMLElement;

    expect(renderCalls).toBe(0);
    expect(editor.textContent).toContain("Draft");
    expect(view.container.querySelector(".cm-editor")).toBeTruthy();
    expect(view.container.querySelector(".shioriDocumentViewer")).toBeNull();
  });

  test("applies the reading width to the live Markdown editor", async () => {
    const view = render(
      <DocumentViewer
        kind="markdown"
        title="styled.md"
        text="# Draft"
        scrollTop={0}
        onScrollTopChange={() => undefined}
        markdownMode="edit"
        onMarkdownModeChange={() => undefined}
        onMarkdownTextChange={() => undefined}
        markdownAppearance={{
          bodyFont: { source: "system", family: "Avenir Next" },
          codeFont: { source: "system", family: "Cascadia Code" },
          headingColor: null,
          fontSize: 18,
          lineHeight: 1.8,
          contentWidth: 720,
        }}
      />,
    );

    await view.findByLabelText("Markdown editor");
    const host = view.container.querySelector(
      "[data-shiori-markdown-live-editor='true']",
    ) as HTMLElement;
    expect(host.style.width).toBe("100%");
    expect(host.style.maxWidth).toBe("");
    expect(document.head.textContent ?? "").toContain("max-width: 720px");
  });

  test("toggles Markdown between reading and live editing with one button", async () => {
    const changes: string[] = [];
    const view = render(
      <DocumentViewer
        kind="markdown"
        title="sample.md"
        text="# Draft"
        scrollTop={0}
        onScrollTopChange={() => undefined}
        markdownMode="preview"
        onMarkdownModeChange={(mode) => changes.push(mode)}
        renderHtml={async () => "<h1>Draft</h1>"}
      />,
    );

    fireEvent.click(view.getByTitle("Edit Markdown"));
    expect(changes).toEqual(["edit"]);
    expect(view.queryByTitle("Preview Markdown")).toBeNull();

    view.rerender(
      <DocumentViewer
        kind="markdown"
        title="sample.md"
        text="# Draft"
        scrollTop={0}
        onScrollTopChange={() => undefined}
        markdownMode="edit"
        onMarkdownModeChange={(mode) => changes.push(mode)}
        onMarkdownTextChange={() => undefined}
      />,
    );

    fireEvent.click(view.getByTitle("Preview Markdown"));
    expect(changes).toEqual(["edit", "preview"]);
    expect(view.queryByTitle("Edit Markdown")).toBeNull();
  });

  // Through React.lazy the first Edit click always suspended, and React 19
  // holds a Suspense fallback ~300 ms: the lag on first entering edit mode.
  test("enters edit mode without a loading pause once the editor is preloaded", async () => {
    const props = {
      kind: "markdown" as const,
      title: "sample.md",
      text: "# Draft",
      scrollTop: 0,
      onScrollTopChange: () => undefined,
      onMarkdownModeChange: () => undefined,
      onMarkdownTextChange: () => undefined,
      renderHtml: async () => "<h1>Draft</h1>",
    };
    const view = render(<DocumentViewer {...props} markdownMode="preview" />);
    await view.findByText("Draft");
    // Reading time: the viewer preloads the editor when the browser is idle.
    await new Promise((resolve) => window.setTimeout(resolve, 2500));

    view.rerender(<DocumentViewer {...props} markdownMode="edit" />);

    expect(view.container.querySelector("[data-shiori-markdown-live-editor]")).toBeTruthy();
    expect(view.container.querySelector('[role="status"]')).toBeNull();
  });

  test("renders front matter safely in the live editor", async () => {
    const view = render(
      <DocumentViewer
        kind="markdown"
        title="sample.md"
        text={["---", "title: Notes", "---", "", "# Body"].join("\n")}
        scrollTop={0}
        onScrollTopChange={() => undefined}
        markdownMode="edit"
        onMarkdownModeChange={() => undefined}
        onMarkdownTextChange={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(view.container.querySelector(".shioriDocumentMetadata")).toBeTruthy();
    });
    expect(view.container.textContent).not.toContain("title: Notes");

    const metadataWidget = view.container.querySelector(
      ".cm-shiori-md-metadata-widget",
    ) as HTMLElement;
    expect(metadataWidget.getAttribute("role")).toBe("button");
    expect(metadataWidget.getAttribute("aria-label")).toBe(
      "Edit document metadata",
    );
    fireEvent.pointerDown(view.container.querySelector(".shioriDocumentMetadata")!);

    await waitFor(() => {
      expect(view.container.textContent).toContain("title: Notes");
    });
  });

  test("opens folded front matter from the keyboard", async () => {
    const view = render(
      <DocumentViewer
        kind="markdown"
        title="keyboard.md"
        text={["---", "title: Notes", "---", "", "# Body"].join("\n")}
        scrollTop={0}
        onScrollTopChange={() => undefined}
        markdownMode="edit"
        onMarkdownModeChange={() => undefined}
        onMarkdownTextChange={() => undefined}
      />,
    );

    const metadataWidget = await waitFor(() => {
      const widget = view.container.querySelector(
        ".cm-shiori-md-metadata-widget",
      ) as HTMLElement | null;
      expect(widget).toBeTruthy();
      return widget!;
    });
    metadataWidget.focus();
    fireEvent.keyDown(metadataWidget, { key: "Enter" });

    await waitFor(() => {
      expect(view.container.textContent).toContain("title: Notes");
    });
  });

  test("starts runnable HTML in a fresh sandbox frame", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revoked: string[] = [];
    let created = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => `blob:shiori-test-${++created}`,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: (url: string) => {
        revoked.push(url);
      },
    });

    try {
      const view = render(
        <DocumentViewer
          kind="html"
          title="sample.html"
          text="<script>window.started = true</script>"
          scrollTop={0}
          onScrollTopChange={() => undefined}
          renderHtml={async () => "<!doctype html><html><body>Static</body></html>"}
        />,
      );

      const run = await view.findByText("Run");
      fireEvent.click(run);
      const iframe = await view.findByTitle("sample.html");

      expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
      expect(iframe.getAttribute("src")).toBe("blob:shiori-test-1");
      view.unmount();
      await new Promise((resolve) => window.setTimeout(resolve, 8));
      expect(revoked).toContain("blob:shiori-test-1");
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectUrl,
      });
    }
  });
});
