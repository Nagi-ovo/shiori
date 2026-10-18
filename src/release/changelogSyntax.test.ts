import { describe, expect, test } from "bun:test";
import { joinWrapped, tableAlign, tableCells } from "./changelogSyntax";

describe("joinWrapped", () => {
  test("keeps the space between Latin words", () => {
    expect(joinWrapped("the wind makes it", "too hard to hear")).toBe(
      "the wind makes it too hard to hear",
    );
  });

  // The zh/ja changelogs wrap mid-sentence. Markdown's newline-to-space
  // rule opens a hole between two characters that belong together.
  test("drops the space between CJK characters", () => {
    expect(joinWrapped("来源文件不会被修改，页内", "批注和链接会一并保留")).toBe(
      "来源文件不会被修改，页内批注和链接会一并保留",
    );
    expect(joinWrapped("ページ内の注釈と", "リンクを保持します")).toBe(
      "ページ内の注釈とリンクを保持します",
    );
  });

  test("keeps the space at a CJK/Latin boundary", () => {
    expect(joinWrapped("导出的", "PDF 不再丢字")).toBe("导出的 PDF 不再丢字");
    expect(joinWrapped("open the", "文档")).toBe("open the 文档");
  });

  test("tolerates empty sides", () => {
    expect(joinWrapped("", "首行")).toBe("首行");
    expect(joinWrapped("首行", "   ")).toBe("首行");
  });
});

describe("joinWrapped before punctuation", () => {
  // "**…work**, as" flattened to "work , as" in the 26.9.26 notes.
  test("no space before closing punctuation", () => {
    expect(joinWrapped("links work", ", as slides use them")).toBe(
      "links work, as slides use them",
    );
  });
});

describe("tables", () => {
  test("cells and alignment from GFM rows", () => {
    expect(tableCells("| | 26.9.9 | This version |")).toEqual(["", "26.9.9", "This version"]);
    expect(tableAlign("|---|:--:|---:|:--|")).toEqual([null, "center", "right", "left"]);
  });
});
