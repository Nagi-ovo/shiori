import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "./markdownBlocks";

describe("parseMarkdown", () => {
  // A soft-wrapped bullet used to become its own paragraph, splitting a
  // single changelog entry into two blocks with a gap between them.
  test("folds a soft-wrapped bullet back into its item", () => {
    const blocks = parseMarkdown(
      ["### Improved", "- **Lead.** first half", "  second half"].join("\n"),
    );
    const list = blocks.find((b) => b.kind === "list");
    expect(list).toBeDefined();
    expect(list).toMatchObject({
      kind: "list",
      items: ["**Lead.** first half second half"],
    });
  });

  test("a quote under a version heading becomes that heading's aside", () => {
    const blocks = parseMarkdown(
      ["# 更新日志", "", "## 26.9.7", "", "> 疾风怒涛", "", "### 界面与性能"].join(
        "\n",
      ),
    );
    // The level-1 title is dropped, so the version row leads.
    expect(blocks[0]).toMatchObject({
      kind: "heading",
      level: 2,
      text: "26.9.7",
      aside: "疾风怒涛",
    });
    expect(blocks.some((b) => b.kind === "quote")).toBe(false);
    expect(blocks[1]).toMatchObject({ kind: "heading", level: 3 });
  });

  test("a quote that is not under a version heading stays a quote", () => {
    const blocks = parseMarkdown(["### Notes", "", "> a plain quote"].join("\n"));
    expect(blocks.some((b) => b.kind === "quote")).toBe(true);
    expect(blocks.some((b) => b.kind === "heading" && "aside" in b && b.aside)).toBe(
      false,
    );
  });

  test("only the first quote is absorbed by a version heading", () => {
    const blocks = parseMarkdown(
      ["## 26.9.7", "> first", "", "> second"].join("\n"),
    );
    expect(blocks[0]).toMatchObject({ level: 2, aside: "first" });
    expect(blocks[1]).toMatchObject({ kind: "quote" });
  });

  // The release notes carry a before/after table under a bullet; folding
  // its rows into the bullet as wrapped text printed them as pipes.
  test("reads a table under a bullet as a table, with its alignment", () => {
    const blocks = parseMarkdown(
      [
        "### 性能",
        "- **Faster.** Measured:",
        "",
        "| | 26.9.9 | Now |",
        "|---|---:|:---:|",
        "| 4× sharp | 110 ms | 67 ms |",
        "| Memory | 259 MB | 106 MB |",
        "",
        "- **Next.** entry",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "list", "table", "list"]);
    expect(blocks[1]).toMatchObject({ items: ["**Faster.** Measured:"] });
    expect(blocks[2]).toEqual({
      kind: "table",
      header: ["", "26.9.9", "Now"],
      align: [null, "right", "center"],
      rows: [
        ["4× sharp", "110 ms", "67 ms"],
        ["Memory", "259 MB", "106 MB"],
      ],
    });
  });

  test("pipe lines without a delimiter row stay prose", () => {
    const blocks = parseMarkdown(["| not | a table |", "| just | pipes |"].join("\n"));
    expect(blocks).toEqual([
      { kind: "paragraph", lines: ["| not | a table |", "| just | pipes |"] },
    ]);
  });
});
