import { afterAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderSafeHtml } from "../../documents/renderSafeHtml";

// DOMPurify explicitly supports jsdom for server-side use and warns that
// happy-dom is not a safe sanitizer host. Keep the security-sensitive HTML
// tests on the same supported DOM implementation DOMPurify tests upstream.
const sanitizerWindow = new JSDOM(
  "<!doctype html><html><head></head><body></body></html>",
  { url: "http://localhost/" },
).window;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);

Object.defineProperties(globalThis, {
  window: { configurable: true, value: sanitizerWindow },
  document: { configurable: true, value: sanitizerWindow.document },
});

afterAll(() => {
  if (previousWindow) {
    Object.defineProperty(globalThis, "window", previousWindow);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  if (previousDocument) {
    Object.defineProperty(globalThis, "document", previousDocument);
  } else {
    delete (globalThis as { document?: unknown }).document;
  }
  sanitizerWindow.close();
});

describe("DocumentViewer safe rendering", () => {
  test("sanitizes executable HTML and unsafe attributes", async () => {
    const html = await renderSafeHtml(
      "html",
      [
        '<!doctype html><html lang="en"><head>',
        "<style>h1 { color: red }</style>",
        '<link rel="stylesheet" href="https://example.com/site.css">',
        '<meta http-equiv="refresh" content="0;url=https://example.com">',
        "</head><body class=\"exported\" style=\"background: black\">",
        '<h1 style="color: blue">Safe title</h1>',
        '<script>window.evil = true</script>',
        '<img src="x" srcset="x 2x" onerror="alert(1)">',
        '<a href="javascript:alert(1)" style="color: red">unsafe link</a>',
        '<iframe src="https://example.com"></iframe>',
        "</body></html>",
      ].join(""),
    );

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<style>h1 { color: red }</style>");
    expect(html).toContain(
      '<link rel="stylesheet" href="https://example.com/site.css">',
    );
    expect(html).toContain("Safe title");
    expect(html).toContain('style="color: blue"');
    expect(html).toContain('<body class="exported" style="background: black">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("http-equiv");
    expect(html).not.toContain("srcset");
    expect(html).not.toContain("<iframe");
  });

  test("renders markdown through the same sanitizer", async () => {
    const html = await renderSafeHtml(
      "markdown",
      [
        "# Title",
        "",
        "[unsafe](javascript:alert(1))",
        "",
        "<style>body { color: red }</style>",
        '<img src="x" onerror="alert(1)">',
      ].join("\n"),
    );

    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toContain("unsafe");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("onerror");
  });

  // The preview and the editor hand the reading position over by source
  // line; pixels do not carry across two different layouts.
  test("marks each markdown block with its first source line", async () => {
    const source = [
      "---", // 1
      "title: Lines",
      "---",
      "# Heading", // 4
      "",
      "A paragraph", // 6
      "over two lines.",
      "",
      "```ts", // 9
      "const a = [1](x);",
      "```",
      "",
      "- item", // 13
      "- [ref][r]",
      "",
      "| a | b |", // 16
      "|---|---|",
      "| 1 | 2 |",
      "",
      "[r]: https://example.test", // 20
      "",
      "> quote", // 22
    ].join("\r\n");
    const html = await renderSafeHtml("markdown", source);
    const doc = new sanitizerWindow.DOMParser().parseFromString(html, "text/html");
    const lines = [...doc.querySelectorAll("[data-source-line]")].map((el) => [
      el.tagName.toLowerCase(),
      Number(el.getAttribute("data-source-line")),
    ]);

    expect(lines).toEqual([
      ["h1", 4],
      ["p", 6],
      ["pre", 9],
      ["ul", 13],
      ["table", 16],
      ["blockquote", 22],
    ]);
    // Rendering block by block keeps reference links resolving.
    expect(html).toContain('href="https://example.test"');
  });

  test("renders markdown front matter as metadata outside the body", async () => {
    const html = await renderSafeHtml(
      "markdown",
      [
        "---",
        "title: Shiori Notes",
        "tags:",
        "  - pdf",
        "  - reading",
        "draft: false",
        "danger: <img src=x onerror=alert(1)>",
        "---",
        "",
        "# Body",
        "",
        "Text after metadata.",
      ].join("\n"),
    );

    expect(html).toContain('class="shioriDocumentMetadata"');
    expect(html).toContain("<dt>title</dt><dd>Shiori Notes</dd>");
    expect(html).toContain("<dt>tags</dt><dd>pdf, reading</dd>");
    expect(html).toContain("<dt>draft</dt><dd>false</dd>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toMatch(/<h1[^>]*>Body<\/h1>/);
    expect(html).not.toContain("title: Shiori Notes");
    expect(html).not.toContain("<hr");
    expect(html).not.toContain("<img src=x");
  });

  // The live editor shows such a block as source; the preview dropped it.
  test("keeps a first section between horizontal rules that holds no metadata", async () => {
    const html = await renderSafeHtml(
      "markdown",
      "---\n\n# Chapter 1\n\nThe whole first chapter.\n\n---\n\n# Chapter 2\n",
    );

    expect(html).toMatch(/<h1 data-source-line="3">Chapter 1<\/h1>/);
    expect(html).toContain("The whole first chapter.");
    expect(html).toMatch(/<h1[^>]*>Chapter 2<\/h1>/);
    expect(html).not.toContain("shioriDocumentMetadata");
  });
});
