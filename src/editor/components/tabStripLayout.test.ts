import { describe, expect, test } from "bun:test";
import {
  ACTIVE_TAB_MIN_WIDTH,
  OVERFLOW_CHIP_WIDTH,
  TAB_GAP,
  TAB_MIN_WIDTH,
  estimateTabWidth,
  planTabStrip,
  splitTitleExtension,
} from "./tabStripLayout";

const tab = (id: string, updatedAt?: number) => ({ id, updatedAt });
const titled = (id: string, title: string, updatedAt?: number) => ({
  id,
  title,
  updatedAt,
});

describe("planTabStrip width estimation", () => {
  test("short titles do not fold just because the floor says they might", () => {
    // Six short names take well under six floors' worth of strip. Planning
    // against the floor folded four of them while there was room for all.
    const tabs = [
      titled("a", "a.md", 1),
      titled("b", "b.md", 2),
      titled("c", "c.md", 3),
      titled("d", "d.md", 4),
      titled("e", "e.md", 5),
      titled("f", "f.md", 6),
    ];
    // Exactly the width six floors would have demanded: under the old plan
    // the gaps alone pushed it over and tabs folded. Six short names fit
    // with room to spare.
    const plan = planTabStrip(tabs, "a", 6 * TAB_MIN_WIDTH);
    expect(plan.overflow).toEqual([]);
  });

  test("a short title is never budgeted up to the floor", () => {
    expect(estimateTabWidth("a.md")).toBeLessThan(TAB_MIN_WIDTH);
    expect(estimateTabWidth("Attention Is All You Need.pdf")).toBeGreaterThan(
      TAB_MIN_WIDTH,
    );
  });

  test("long titles still fold, and the active tab is never one of them", () => {
    const long = "Attention Is All You Need — annotated reading copy.pdf";
    const tabs = [
      titled("a", long, 1),
      titled("b", long, 2),
      titled("c", long, 3),
    ];
    const plan = planTabStrip(tabs, "c", 300);
    expect(plan.visible.map((t) => t.id)).toContain("c");
    expect(plan.overflow.length).toBeGreaterThan(0);
  });

  test("full-width glyphs are budgeted wider than Latin ones", () => {
    // Four CJK characters take about twice the advance of four Latin ones,
    // which is what keeps a Chinese or Japanese title from being planned as
    // if it were half its rendered width.
    expect(estimateTabWidth("标注笔记")).toBeGreaterThan(
      estimateTabWidth("abcd"),
    );
  });
});

describe("planTabStrip", () => {
  test("keeps every tab when the strip is wide enough", () => {
    const tabs = [tab("a", 1), tab("b", 2), tab("c", 3)];
    const plan = planTabStrip(tabs, "b", 2000);
    expect(plan.visible.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(plan.overflow).toEqual([]);
  });

  test("folds least recently used tabs first, never the active one", () => {
    // Room for the active tab plus one more (and the chip).
    const width =
      ACTIVE_TAB_MIN_WIDTH + TAB_MIN_WIDTH + TAB_GAP * 2 + OVERFLOW_CHIP_WIDTH;
    const tabs = [tab("old", 1), tab("mid", 5), tab("active", 2), tab("new", 9)];
    const plan = planTabStrip(tabs, "active", width);
    expect(plan.visible.map((t) => t.id)).toEqual(["active", "new"]);
    expect(plan.overflow.map((t) => t.id)).toEqual(["old", "mid"]);
  });

  test("original strip order survives folding", () => {
    const width =
      ACTIVE_TAB_MIN_WIDTH +
      2 * TAB_MIN_WIDTH +
      TAB_GAP * 3 +
      OVERFLOW_CHIP_WIDTH;
    const tabs = [tab("a", 9), tab("b", 1), tab("c", 8), tab("d", 7)];
    const plan = planTabStrip(tabs, "c", width);
    // "b" (oldest) folds; the survivors keep their left-to-right order.
    expect(plan.visible.map((t) => t.id)).toEqual(["a", "c", "d"]);
  });

  test("a hostile width still shows the active tab alone", () => {
    const tabs = [tab("a", 1), tab("b", 2), tab("c", 3)];
    const plan = planTabStrip(tabs, "b", 10);
    expect(plan.visible.map((t) => t.id)).toEqual(["b"]);
    expect(plan.overflow.length).toBe(2);
  });

  test("no active tab: folds by recency and keeps at least one tab", () => {
    const tabs = [tab("a", 3), tab("b", 1)];
    const plan = planTabStrip(tabs, null, 10);
    expect(plan.visible.map((t) => t.id)).toEqual(["a"]);
    expect(plan.overflow.map((t) => t.id)).toEqual(["b"]);
  });
});

describe("splitTitleExtension", () => {
  test("splits a normal filename", () => {
    expect(splitTitleExtension("Attention Is All You Need.pdf")).toEqual({
      base: "Attention Is All You Need",
      ext: ".pdf",
    });
  });

  test("keeps a title without an extension whole", () => {
    expect(splitTitleExtension("阅读笔记 · 三月")).toEqual({
      base: "阅读笔记 · 三月",
      ext: "",
    });
  });

  test("only the last dot segment counts as the extension", () => {
    expect(splitTitleExtension("v2.0 release notes.md")).toEqual({
      base: "v2.0 release notes",
      ext: ".md",
    });
  });

  test("a bare dotfile-style name does not lose its whole text", () => {
    const split = splitTitleExtension(".gitignore");
    expect(split.base + split.ext).toBe(".gitignore");
  });
});
