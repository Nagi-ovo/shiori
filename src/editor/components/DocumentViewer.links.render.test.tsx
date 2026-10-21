import "../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import type { DocumentViewer as DocumentViewerComponent } from "./DocumentViewer";

// Link clicks in a rendered document: every kind of link is the viewer's to
// handle, because a default navigation replaces the app (Markdown renders in
// the app's own document) or the document frame.
let DocumentViewer: typeof DocumentViewerComponent;
let opened: string[] = [];
const realOpen = window.open;

function renderMarkdown(html: string) {
  return render(
    <DocumentViewer
      kind="markdown"
      title="links.md"
      text={html}
      scrollTop={0}
      onScrollTopChange={() => undefined}
      renderHtml={async () => html}
    />,
  );
}

describe("DocumentViewer link clicks", () => {
  beforeAll(async () => {
    DocumentViewer = (await import("./DocumentViewer")).DocumentViewer;
    await i18n.changeLanguage("en");
  });

  beforeEach(() => {
    opened = [];
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
  });

  afterEach(() => {
    window.open = realOpen;
    cleanup();
    document.body.replaceChildren();
  });

  test("opens an image-map area externally instead of navigating the app", async () => {
    const view = renderMarkdown(
      '<p><map name="m"><area shape="rect" coords="0,0,4000,4000" href="https://evil.example/login" alt="Map"></map><img usemap="#m" alt="map"></p>',
    );
    await view.findByAltText("map");
    const area = view.container.querySelector("area")!;

    expect(fireEvent.click(area)).toBe(false);
    expect(opened).toEqual(["https://evil.example/login"]);
  });

  test("opens an SVG link that only has xlink:href externally", async () => {
    const view = renderMarkdown(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="https://evil.example/svg"><text>svg link</text></a></svg>',
    );
    await view.findByText("svg link");
    const text = view.container.querySelector("text")!;

    expect(fireEvent.click(text)).toBe(false);
    expect(opened).toEqual(["https://evil.example/svg"]);
  });

  test("scrolls a Markdown fragment link to its target instead of opening it", async () => {
    const view = renderMarkdown(
      '<p><a href="#ch%202">Go to chapter 2</a></p><h2 id="ch 2">Chapter 2</h2>',
    );
    const link = await view.findByText("Go to chapter 2");
    const heading = view.getByText("Chapter 2");
    let scrolled = 0;
    heading.scrollIntoView = () => {
      scrolled += 1;
    };

    expect(fireEvent.click(link)).toBe(false);
    expect(opened).toEqual([]);
    expect(scrolled).toBe(1);
  });

  // marked gives headings no id, so a TOC written for GitHub targets the
  // heading's slug; the default renderer runs here, not a stub.
  test("scrolls a Markdown TOC link to the heading its slug names", async () => {
    const view = render(
      <DocumentViewer
        kind="markdown"
        title="toc.md"
        text={"[Contents](#chapter-2)\n[Again](#whats-new-1)\n\n## What's new?\n\n## Chapter 2\n\n## What's new?\n"}
        scrollTop={0}
        onScrollTopChange={() => undefined}
      />,
    );
    const contents = await view.findByText("Contents");
    const scrolled: string[] = [];
    for (const heading of Array.from(view.container.querySelectorAll("h2"))) {
      heading.scrollIntoView = () => {
        scrolled.push(`${heading.textContent}@${heading.getAttribute("data-source-line")}`);
      };
    }

    expect(fireEvent.click(contents)).toBe(false);
    expect(fireEvent.click(view.getByText("Again"))).toBe(false);
    expect(scrolled).toEqual(["Chapter 2@6", "What's new?@8"]);
    expect(opened).toEqual([]);
  });

  test("scrolls an HTML fragment link inside the document frame", async () => {
    const view = render(
      <DocumentViewer
        kind="html"
        title="toc.html"
        text="<a href='#ch2'>Chapter 2</a>"
        scrollTop={0}
        onScrollTopChange={() => undefined}
        renderHtml={async () =>
          '<!doctype html><html><body><a href="#ch2">Go</a><a name="ch2">Chapter 2</a><a href="https://example.com/x">Out</a></body></html>'
        }
      />,
    );
    const iframe = (await view.findByTitle("toc.html")) as HTMLIFrameElement;
    fireEvent.load(iframe);
    const doc = iframe.contentDocument!;
    const [toc, target, out] = Array.from(doc.querySelectorAll("a"));
    let scrolled = 0;
    target!.scrollIntoView = () => {
      scrolled += 1;
    };
    const click = () =>
      new (doc.defaultView as unknown as typeof window).MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });

    const tocClick = click();
    toc!.dispatchEvent(tocClick);
    expect(tocClick.defaultPrevented).toBe(true);
    expect(scrolled).toBe(1);
    expect(opened).toEqual([]);

    const outClick = click();
    out!.dispatchEvent(outClick);
    expect(outClick.defaultPrevented).toBe(true);
    expect(opened).toEqual(["https://example.com/x"]);
  });
});
