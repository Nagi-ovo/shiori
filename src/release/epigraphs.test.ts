import { describe, expect, test } from "bun:test";
import {
  EPIGRAPHS,
  LOW_WATER_MARK,
  formatEpigraph,
  nextEpigraph,
  epigraphForVersion,
  remainingEpigraphs,
  type Epigraph,
} from "./epigraphs";

// The whole point of the pool is that a release takes the next entry
// without anyone choosing. That only stays true if consumption is
// append-only and the ledger is never rewritten — a shipped release's
// epigraph is in a changelog users have already read.
describe("release epigraphs", () => {
  test("every entry carries all three languages and an episode", () => {
    for (const entry of EPIGRAPHS) {
      expect(entry.ja.trim().length).toBeGreaterThan(0);
      expect(entry.zh.trim().length).toBeGreaterThan(0);
      expect(entry.en.trim().length).toBeGreaterThan(0);
      expect(entry.episode).toBeGreaterThan(0);
    }
  });

  test("titles are unique, so no two releases share a codename", () => {
    for (const lang of ["ja", "zh", "en"] as const) {
      const titles = EPIGRAPHS.map((e) => e[lang]);
      expect(new Set(titles).size).toBe(titles.length);
    }
  });

  test("entries stay in broadcast order", () => {
    const episodes = EPIGRAPHS.map((e) => e.episode);
    expect([...episodes].sort((a, b) => a - b)).toEqual(episodes);
  });

  // Consumption walks the array from the top. A gap would mean an entry
  // was skipped — either an edit to a shipped row, or a hand-written
  // version on a later row that nextEpigraph() will hand out again.
  test("consumed entries form an unbroken run at the top", () => {
    const firstUnused = EPIGRAPHS.findIndex((e) => !e.version);
    if (firstUnused === -1) return; // pool fully consumed
    const after = EPIGRAPHS.slice(firstUnused);
    expect(after.every((e) => !e.version)).toBe(true);
  });

  test("each release consumes at most one entry", () => {
    const versions = EPIGRAPHS.filter((e) => e.version).map((e) => e.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("nextEpigraph hands out the first unused entry", () => {
    const pool: Epigraph[] = [
      { episode: 1, ja: "壱", zh: "一", en: "One", version: "1.0.0" },
      { episode: 2, ja: "弐", zh: "二", en: "Two" },
      { episode: 3, ja: "参", zh: "三", en: "Three" },
    ];
    expect(nextEpigraph(pool)?.en).toBe("Two");
    expect(remainingEpigraphs(pool)).toBe(2);
    expect(epigraphForVersion("1.0.0", pool)?.en).toBe("One");
    expect(epigraphForVersion("9.9.9", pool)).toBeUndefined();
  });

  test("nextEpigraph returns null once the pool is spent", () => {
    const pool: Epigraph[] = [
      { episode: 1, ja: "壱", zh: "一", en: "One", version: "1.0.0" },
    ];
    expect(nextEpigraph(pool)).toBeNull();
    expect(remainingEpigraphs(pool)).toBe(0);
  });

  // Fails on the release that would leave fewer than LOW_WATER_MARK
  // entries, so a new season gets curated before a release day runs the
  // pool dry.
  test("the pool still has headroom", () => {
    expect(remainingEpigraphs()).toBeGreaterThan(LOW_WATER_MARK);
  });

  // Bare title, no series and no episode number: the codename is a
  // signature, not a citation.
  test("formatEpigraph emits the bare title for the language", () => {
    const entry: Epigraph = {
      episode: 1,
      ja: "疾風怒濤",
      zh: "疾风怒涛",
      en: "Tempestuous Temperaments",
    };
    expect(formatEpigraph(entry, "zh")).toBe("疾风怒涛");
    expect(formatEpigraph(entry, "ja")).toBe("疾風怒濤");
    expect(formatEpigraph(entry, "en")).toBe("Tempestuous Temperaments");
  });
});

// The epigraph only reaches users if it is actually in the markdown the
// app and the website render. A stamped version with no line in the
// changelog is a silent no-op.
describe("stamped epigraphs appear in the changelogs", () => {
  const files = {
    zh: Bun.file("docs/changelog/zh.md"),
    en: Bun.file("docs/changelog/en.md"),
    ja: Bun.file("docs/changelog/ja.md"),
  } as const;

  test("each consumed entry is quoted in all three changelogs", async () => {
    const consumed = EPIGRAPHS.filter((e) => e.version);
    expect(consumed.length).toBeGreaterThan(0);

    for (const lang of ["zh", "en", "ja"] as const) {
      const text = await files[lang].text();
      for (const entry of consumed) {
        expect(text).toContain(`> ${formatEpigraph(entry, lang)}`);
      }
    }
  });
});
