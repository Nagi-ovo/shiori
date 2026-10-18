import { describe, expect, test } from "bun:test";
import {
  changelogSectionToMarkdown,
  changelogSectionToNotes,
  sectionOf,
} from "./notes";

const SAMPLE = [
  "# 更新日志",
  "",
  "## 26.9.7",
  "",
  "> 疾风怒涛",
  "",
  "### 界面与性能",
  "",
  "- **所有主题下的辅助文字更清晰了。** 状态栏与提示都达到标准对比度。",
  "- **大量批注下编辑更流畅，空闲时",
  "  更省电。** 上万条批注的导出状态在空闲时计算。",
  "",
  "### 页面与 PDF",
  "",
  "- 一条没有加粗开头的条目。",
  "",
  "## 26.8.12",
  "",
  "### 旧的一节",
  "",
  "- 不该出现在 26.9.7 的说明里。",
].join("\n");

describe("sectionOf", () => {
  test("stops at the next version heading", () => {
    const section = sectionOf(SAMPLE, "26.9.7");
    expect(section).not.toBeNull();
    expect(section!.lines.join("\n")).toContain("界面与性能");
    expect(section!.lines.join("\n")).not.toContain("旧的一节");
  });

  test("returns null for a version that is not there", () => {
    expect(sectionOf(SAMPLE, "99.9.9")).toBeNull();
  });
});

describe("changelogSectionToNotes", () => {
  const notes = changelogSectionToNotes(SAMPLE, "26.9.7");

  test("keeps only the requested version", () => {
    expect(notes).not.toContain("旧的一节");
    expect(notes).not.toContain("不该出现");
  });

  test("drops the epigraph quote", () => {
    expect(notes).not.toContain("疾风怒涛");
    expect(notes).not.toContain(">");
  });

  test("group headings become bare lines, entries become bullets", () => {
    expect(notes.split("\n")[0]).toBe("界面与性能");
    expect(notes).toContain("• 所有主题下的辅助文字更清晰了。状态栏与提示都达到标准对比度。");
    expect(notes).toContain("\n\n页面与 PDF\n");
  });

  // The lead of this entry wraps across two source lines, so its closing
  // `**` sits on the continuation. Stripping markers per line left the
  // stray `**` in the middle of the shipped sentence.
  test("folds a soft-wrapped bold lead before stripping its markers", () => {
    expect(notes).toContain(
      "• 大量批注下编辑更流畅，空闲时更省电。上万条批注的导出状态在空闲时计算。",
    );
    expect(notes).not.toContain("**");
  });

  test("an entry with no bold lead survives unchanged", () => {
    expect(notes).toContain("• 一条没有加粗开头的条目。");
  });

  test("an unknown version yields nothing", () => {
    expect(changelogSectionToNotes(SAMPLE, "99.9.9")).toBe("");
  });
});

// 26.9.26 shipped a before/after table under an entry and bold leads
// followed by punctuation; the first run of the notes folded the table
// into one line of pipes and put a space before each comma.
describe("changelogSectionToNotes with a table and punctuation after a lead", () => {
  const markdown = [
    "## 26.9.26",
    "",
    "### Performance",
    "",
    "- **PDFs stay sharp at 8× zoom.** Measured on an 8-page PDF:",
    "",
    "| | 26.9.9 | This version |",
    "|---|---:|---:|",
    "| Memory at high zoom | 252–259 MB | 106 MB |",
    "| 高倍缩放占用的内存 | 252–259 MB | 106 MB |",
    "",
    "### Fixed",
    "",
    "- **“Next page” links in a PDF work**, as slides often use them.",
  ].join("\n");
  const notes = changelogSectionToNotes(markdown, "26.9.26");

  test("each table row becomes an indented sub-item under its entry", () => {
    expect(notes).toBe(
      [
        "Performance",
        "• PDFs stay sharp at 8× zoom. Measured on an 8-page PDF:",
        "  ◦ Memory at high zoom: 252–259 MB → 106 MB",
        "  ◦ 高倍缩放占用的内存：252–259 MB → 106 MB",
        "",
        "Fixed",
        "• “Next page” links in a PDF work, as slides often use them.",
      ].join("\n"),
    );
  });
});

describe("changelogSectionToMarkdown", () => {
  test("keeps the section's markdown, minus the epigraph and other versions", () => {
    const markdown = changelogSectionToMarkdown(SAMPLE, "26.9.7");
    expect(markdown.startsWith("### 界面与性能")).toBe(true);
    expect(markdown).toContain("- **所有主题下的辅助文字更清晰了。**");
    expect(markdown).not.toContain("疾风怒涛");
    expect(markdown).not.toContain("旧的一节");
  });
});
