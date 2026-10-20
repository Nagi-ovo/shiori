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
});
