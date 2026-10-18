import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "../editor/components/markdownBlocks";
import { notesMarkdownFor } from "./updateNotes";

const TABLE = [
  "### Performance",
  "",
  "- **PDFs stay sharp at 8× zoom.** Measured on an 8-page PDF:",
  "",
  "| | 26.9.9 | This version |",
  "|---|---:|---:|",
  "| Memory at high zoom | 252–259 MB | 106 MB |",
].join("\n");

describe("notesMarkdownFor", () => {
  // 26.9.26's notice showed the before/after table as loose lines: the notes
  // file only had a plain-text flattening to offer it.
  test("a file carrying markdown renders its table as a table", () => {
    const markdown = notesMarkdownFor(
      { en: "Performance\n• flattened", markdown: { en: TABLE, zh: "### 性能" } },
      "en-GB",
    );
    const table = parseMarkdown(markdown ?? "").find((b) => b.kind === "table");
    expect(table).toBeDefined();
    expect(JSON.stringify(table)).toContain("106 MB");
  });

  test("a plain-text file from an older release still lists its entries", () => {
    const markdown = notesMarkdownFor(
      { en: "Fixed\n• Closing a tab no longer flashes the home screen." },
      "en",
    );
    expect(markdown).toBe(
      "### Fixed\n- Closing a tab no longer flashes the home screen.",
    );
  });

  test("a missing language falls back to English", () => {
    expect(
      notesMarkdownFor({ en: "x", markdown: { en: "### English", zh: "### 中文" } }, "ja"),
    ).toBe("### English");
  });

  test("an unusable file yields nothing, so the manifest body shows", () => {
    expect(notesMarkdownFor(null, "en")).toBeNull();
    expect(notesMarkdownFor({ markdown: {} }, "en")).toBeNull();
  });
});
