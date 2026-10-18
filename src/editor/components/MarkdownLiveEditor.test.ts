import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  collectMarkdownLiveDecorationSpans,
  collectMarkdownMetadataDecorationSpans,
  metadataSourcePositionForEntry,
} from "./MarkdownLiveEditorCore";

function stateFor(doc: string, cursor: number = 0): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [markdown({ base: markdownLanguage })],
  });
}

describe("MarkdownLiveEditor decorations", () => {
  test("keeps the active line as source and decorates the rest", () => {
    const doc = [
      "# Active title",
      "",
      "Plain **bold** and [link](https://example.test).",
    ].join("\n");
    const spans = collectMarkdownLiveDecorationSpans(stateFor(doc), [
      { from: 0, to: doc.length },
    ]);
    const hiddenText = spans
      .filter((span) => span.kind === "hidden")
      .map((span) => doc.slice(span.from, span.to));

    expect(hiddenText).not.toContain("#");
    expect(hiddenText).toContain("**");
    expect(hiddenText).toContain("https://example.test");
  });

  test("renders front matter as metadata and leaves fenced code undecorated", () => {
    const doc = [
      "---",
      "title: Notes",
      "---",
      "",
      "```",
      "**raw**",
      "```",
      "",
      "## Rendered",
    ].join("\n");
    const spans = collectMarkdownLiveDecorationSpans(
      stateFor(doc),
      [{ from: 0, to: doc.length }],
      false,
    );
    const sourceLines = spans
      .filter((span) => span.kind === "sourceLine")
      .map((span) =>
        doc.slice(span.from, doc.indexOf("\n", span.from) + 1 || doc.length),
      );
    const hiddenText = spans
      .filter((span) => span.kind === "hidden")
      .map((span) => doc.slice(span.from, span.to));
    const metadata = collectMarkdownMetadataDecorationSpans(
      stateFor(doc),
      false,
    )[0];

    expect(metadata?.html).toContain("<dt>title</dt><dd>Notes</dd>");
    expect(sourceLines.join("")).not.toContain("title: Notes");
    // Markdown inside the fence is code, not emphasis.
    expect(hiddenText).not.toContain("**");
    expect(hiddenText).toContain("## ");
  });

  test("renders front matter metadata with the default cursor at document start", () => {
    const doc = ["---", "title: Notes", "---", "", "Body"].join("\n");
    const state = stateFor(doc, 0);
    const spans = collectMarkdownLiveDecorationSpans(
      state,
      [{ from: 0, to: doc.length }],
    );
    const metadata = collectMarkdownMetadataDecorationSpans(state)[0];
    const sourceLines = spans
      .filter((span) => span.kind === "sourceLine")
      .map((span) =>
        doc.slice(span.from, doc.indexOf("\n", span.from) + 1 || doc.length),
      );

    expect(metadata?.html).toContain("<dt>title</dt><dd>Notes</dd>");
    expect(sourceLines.join("")).not.toContain("title: Notes");
  });

  test("keeps front matter rendered when selection enters it implicitly", () => {
    const doc = ["---", "title: Notes", "---", "", "Body"].join("\n");
    const spans = collectMarkdownLiveDecorationSpans(
      stateFor(doc, doc.indexOf("Notes")),
      [{ from: 0, to: doc.length }],
    );
    const metadata = collectMarkdownMetadataDecorationSpans(
      stateFor(doc, doc.indexOf("Notes")),
    );
    const sourceLines = spans
      .filter((span) => span.kind === "sourceLine")
      .map((span) =>
        doc.slice(span.from, doc.indexOf("\n", span.from) + 1 || doc.length),
      );

    expect(metadata[0]?.html).toContain("<dt>title</dt><dd>Notes</dd>");
    expect(sourceLines.join("")).not.toContain("title: Notes");
  });

  test("does not expose the default cursor line until the editor is focused", () => {
    const doc = "# Rendered title\n\nBody";
    const spans = collectMarkdownLiveDecorationSpans(
      stateFor(doc),
      [{ from: 0, to: doc.length }],
      false,
    );
    const hiddenText = spans
      .filter((span) => span.kind === "hidden")
      .map((span) => doc.slice(span.from, span.to));

    expect(spans.some((span) => span.kind === "sourceLine")).toBe(false);
    expect(hiddenText).toContain("# ");
  });

  test("removes ATX and Setext marker whitespace instead of visual indents", () => {
    const doc = [
      "# Heading one",
      "",
      "  ## Heading two",
      "",
      "   Setext heading",
      "   ---",
    ].join("\n");
    const spans = collectMarkdownLiveDecorationSpans(
      stateFor(doc),
      [{ from: 0, to: doc.length }],
      false,
    );
    const hiddenText = spans
      .filter((span) => span.kind === "hidden")
      .map((span) => doc.slice(span.from, span.to));

    expect(hiddenText).toContain("# ");
    expect(hiddenText).toContain("  ## ");
    expect(hiddenText).toContain("   ");
    expect(hiddenText).toContain("   ---");
  });

  test("folds nested and closing ATX separator whitespace", () => {
    const doc = [
      "> # Quote heading",
      "",
      "- # List heading",
      "",
      "### Closed heading ###   ",
    ].join("\n");
    const spans = collectMarkdownLiveDecorationSpans(
      stateFor(doc),
      [{ from: 0, to: doc.length }],
      false,
    );
    const hiddenText = spans
      .filter((span) => span.kind === "hidden")
      .map((span) => doc.slice(span.from, span.to));

    expect(hiddenText.filter((text) => text === " # ")).toHaveLength(2);
    expect(hiddenText).toContain("### ");
    expect(hiddenText).toContain(" ###   ");
  });

  test("boxes an indented code block as code", () => {
    const doc = "    code\n\n    Centered paragraph";
    const spans = collectMarkdownLiveDecorationSpans(
      stateFor(doc, doc.length),
      [{ from: 0, to: doc.length }],
      false,
    );
    const codeLines = spans
      .filter((span) => span.kind === "codeLine")
      .map((span) => [span.from, span.edge]);

    expect(codeLines).toEqual([
      [0, "first"],
      [doc.indexOf("\n\n") + 1, undefined],
      [doc.indexOf("    Centered"), "last"],
    ]);
    expect(spans.some((span) => span.kind === "codeFence")).toBe(false);
    // The indent is syntax, folded like a fence.
    expect(
      spans
        .filter((span) => span.kind === "hidden")
        .map((span) => [span.from, doc.slice(span.from, span.to)]),
    ).toEqual([
      [0, "    "],
      [doc.indexOf("    Centered"), "    "],
    ]);
  });

  // The edit view showed a fenced block as raw source, fences and all,
  // where the preview shows a box of code.
  test("boxes a fenced block and folds its fences into the language", () => {
    const doc = ["Intro", "", "```ts", "const a = 1;", "```", "", "Outro"].join("\n");
    const spans = collectMarkdownLiveDecorationSpans(
      stateFor(doc, 0),
      [{ from: 0, to: doc.length }],
      false,
    );
    const lineOf = (from: number) => doc.slice(from, doc.indexOf("\n", from));

    expect(
      spans
        .filter((span) => span.kind === "codeLine")
        .map((span) => [lineOf(span.from), span.edge]),
    ).toEqual([
      ["```ts", "first"],
      ["const a = 1;", undefined],
      ["```", "last"],
    ]);
    expect(
      spans
        .filter((span) => span.kind === "codeFence")
        .map((span) => [doc.slice(span.from, span.to), span.text]),
    ).toEqual([
      ["```ts", "ts"],
      ["```", ""],
    ]);
  });

  test("shows a fenced block's fences while the cursor is in it", () => {
    const doc = ["```ts", "const a = 1;", "```"].join("\n");
    const spans = collectMarkdownLiveDecorationSpans(
      stateFor(doc, doc.indexOf("a =")),
      [{ from: 0, to: doc.length }],
    );

    // Still a box, so stepping in does not reflow the page; fences editable.
    expect(spans.filter((span) => span.kind === "codeLine")).toHaveLength(3);
    expect(spans.some((span) => span.kind === "codeFence")).toBe(false);
  });

  test("leaves an unclosed fence's last line alone while it is typed", () => {
    const doc = ["```py", "print(1)"].join("\n");
    const spans = collectMarkdownLiveDecorationSpans(
      stateFor(doc, 0),
      [{ from: 0, to: doc.length }],
      false,
    );

    expect(
      spans
        .filter((span) => span.kind === "codeFence")
        .map((span) => doc.slice(span.from, span.to)),
    ).toEqual(["```py"]);
  });

  test("uses GFM decorations without hiding autolink text", () => {
    const doc = [
      "- [x] finished",
      "",
      "~~removed~~",
      "",
      "<https://example.test>",
    ].join("\n");
    const spans = collectMarkdownLiveDecorationSpans(
      stateFor(doc),
      [{ from: 0, to: doc.length }],
      false,
    );
    const hiddenText = spans
      .filter((span) => span.kind === "hidden")
      .map((span) => doc.slice(span.from, span.to));

    expect(spans.some((span) => span.kind === "listMark")).toBe(true);
    expect(spans.some((span) => span.kind === "taskChecked")).toBe(true);
    expect(spans.some((span) => span.kind === "strikethrough")).toBe(true);
    expect(spans.some((span) => span.kind === "link")).toBe(true);
    expect(hiddenText).toContain("~~");
    expect(hiddenText).not.toContain("https://example.test");
  });

  test("keeps GFM tables as editable source blocks", () => {
    const doc = ["| A | B |", "| - | - |", "| 1 | 2 |"].join("\n");
    const spans = collectMarkdownLiveDecorationSpans(
      stateFor(doc),
      [{ from: 0, to: doc.length }],
      false,
    );
    const sourceLines = spans
      .filter((span) => span.kind === "sourceLine")
      .map((span) => span.from);

    expect(sourceLines).toEqual([0, doc.indexOf("| -"), doc.indexOf("| 1")]);
  });

  test("limits full-document selection decorations to the visible range", () => {
    const doc = Array.from({ length: 50_000 }, (_, index) => `line ${index}`).join(
      "\n",
    );
    const state = EditorState.create({
      doc,
      selection: { anchor: 0, head: doc.length },
      extensions: [markdown({ base: markdownLanguage })],
    });
    const spans = collectMarkdownLiveDecorationSpans(
      state,
      [{ from: 0, to: 120 }],
      true,
    );

    expect(spans.filter((span) => span.kind === "sourceLine").length).toBeLessThan(
      30,
    );
  });

  test("renders BOM-prefixed front matter and escapes hostile values", () => {
    const doc = [
      "\uFEFF---",
      "title: </dd><script>window.pwned = true</script>",
      "---",
      "",
      "Body",
    ].join("\n");
    const metadata = collectMarkdownMetadataDecorationSpans(
      stateFor(doc),
      false,
    )[0];

    expect(metadata?.html).toContain("&lt;/dd&gt;&lt;script&gt;");
    expect(metadata?.html).not.toContain("<script>");
  });

  test("keeps front matter folded across a full-document selection", () => {
    const doc = ["---", "title: Notes", "---", "", "Body"].join("\n");
    const state = EditorState.create({
      doc,
      selection: { anchor: 0, head: doc.length },
      extensions: [markdown({ base: markdownLanguage })],
    });

    expect(collectMarkdownMetadataDecorationSpans(state)[0]?.html).toContain(
      "<dt>title</dt><dd>Notes</dd>",
    );
  });

  test("maps rendered metadata clicks back to YAML source positions", () => {
    const doc = [
      "---",
      "title: Notes",
      "author: Jane Doe",
      "---",
      "",
      "Body",
    ].join("\n");
    const frontMatter = { from: 0, to: doc.indexOf("\n\nBody") + 1 };
    const state = stateFor(doc);

    expect(
      metadataSourcePositionForEntry(state, frontMatter, 0, "key", 2),
    ).toBe(doc.indexOf("title") + 2);
    expect(
      metadataSourcePositionForEntry(state, frontMatter, 1, "value", 5),
    ).toBe(doc.indexOf("Jane Doe") + 5);
  });

  test("maps rendered metadata clicks back to TOML source positions", () => {
    const doc = [
      "+++",
      "[author]",
      'name = "Jane Doe"',
      "+++",
      "",
      "Body",
    ].join("\n");
    const frontMatter = { from: 0, to: doc.indexOf("\n\nBody") + 1 };
    const state = stateFor(doc);

    expect(
      metadataSourcePositionForEntry(state, frontMatter, 0, "key", 2),
    ).toBe(doc.indexOf("name") + 2);
    expect(
      metadataSourcePositionForEntry(state, frontMatter, 0, "value", 1),
    ).toBe(doc.indexOf('"Jane Doe"') + 1);
  });
});
