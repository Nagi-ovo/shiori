import { describe, expect, test } from "bun:test";
import { getReleases } from "../site/src/content/changelog";
import {
  changelogHref,
  parseHash,
  releaseAnchorId,
} from "../site/src/router/route";

describe("website changelog parsing", () => {
  test("accepts date-version headings without a repeated calendar date", () => {
    for (const lang of ["en", "zh", "ja"] as const) {
      const releases = getReleases(lang);
      // A shipped release, not the newest: pinning releases[0] broke on
      // every release.
      const shipped = releases.find((release) => release.version === "26.9.9");

      expect(shipped).toMatchObject({ version: "26.9.9", date: "" });
      expect(shipped?.groups.length).toBeGreaterThan(0);
      expect(
        releases.find((release) => release.version === "26.7.27"),
      ).toBeDefined();
    }
  });

  // Between releases the markdown carries an "Unreleased" section for work
  // that has landed but not shipped. The app shows it; the website must not
  // list it as a release, nor attach its items to the previous one.
  test("leaves the unreleased section off the website", () => {
    for (const lang of ["en", "zh", "ja"] as const) {
      const releases = getReleases(lang);
      expect(
        releases.some((release) =>
          /^\[?(unreleased|未发布|未リリース)\]?$/i.test(release.version),
        ),
      ).toBe(false);
      expect(releases[0]?.version).toMatch(/^\d/);
    }
  });

  // A `>` line under the version heading is that release's codename. The
  // parser used to drop it: with no group open yet it matched nothing.
  test("captures the release epigraph from under the version heading", () => {
    const epigraph = (lang: "en" | "zh" | "ja") =>
      getReleases(lang).find((release) => release.version === "26.9.9")?.epigraph;
    expect(epigraph("zh")).toBe("以心传心");
    expect(epigraph("en")).toBe("Hellhounds for Hire");
    expect(epigraph("ja")).toBe("以心伝心");
  });

  // Soft-wrapped bullets are folded onto the item they continue. Markdown
  // turns the newline into a space, which is wrong between two CJK
  // characters. Asserted on a real wrapped entry rather than by scanning
  // every item: an intentional space between CJK words inside one source
  // line is legitimate and indistinguishable after the fact.
  test("folds soft-wrapped CJK bullets without inserting a space", () => {
    const release = getReleases("zh").find((r) => r.version === "26.8.12");
    const wrapped = release?.groups
      .flatMap((g) => g.items)
      .find((item) => item.lead.startsWith("可以把另一份 PDF"));
    // Source wraps between 「页内」 and 「批注」.
    expect(wrapped?.rest).toContain("页内批注");
    expect(wrapped?.rest).not.toContain("页内 批注");

  });

  test("keeps the explicit dates on legacy semver headings", () => {
    const releases = getReleases("en");

    expect(releases.find((release) => release.version === "0.1.25")).toMatchObject({
      date: "2026-07-07",
    });
  });
});

// `#/changelog/<version>` opens the changelog on one release. The version in
// the URL is the markdown heading's, so a link copied from the page resolves
// back to the same entry in every language.
describe("website changelog deep links", () => {
  test("parses a version, with or without the v prefix", () => {
    expect(parseHash("#/changelog/26.9.27")).toEqual({ route: "changelog", version: "26.9.27" });
    expect(parseHash("#/changelog/v26.9.27")).toEqual({ route: "changelog", version: "26.9.27" });
    expect(parseHash("#/changelog/V0.1.25")).toEqual({ route: "changelog", version: "0.1.25" });
    expect(parseHash("#/changelog/26.9.27/")).toEqual({ route: "changelog", version: "26.9.27" });
  });

  test("keeps the plain changelog and the other routes as they were", () => {
    expect(parseHash("#/changelog")).toEqual({ route: "changelog", version: null });
    expect(parseHash("#/changelog/")).toEqual({ route: "changelog", version: null });
    expect(parseHash("#/shortcuts")).toEqual({ route: "shortcuts", version: null });
    expect(parseHash("#/privacy")).toEqual({ route: "privacy", version: null });
    expect(parseHash("#/support")).toEqual({ route: "support", version: null });
    // Section anchors on the marketing page are not routes.
    expect(parseHash("#features")).toEqual({ route: "marketing", version: null });
    expect(parseHash("#download")).toEqual({ route: "marketing", version: null });
    expect(parseHash("")).toEqual({ route: "marketing", version: null });
    expect(parseHash("#/changelogx")).toEqual({ route: "marketing", version: null });
  });

  test("an unknown or malformed version still opens the changelog", () => {
    expect(parseHash("#/changelog/9.9.9").route).toBe("changelog");
    expect(parseHash("#/changelog/%E0%A4%A").route).toBe("changelog");
  });

  test("every release's link resolves back to that release", () => {
    for (const lang of ["en", "zh", "ja"] as const) {
      const releases = getReleases(lang);
      expect(releases.some((r) => r.version === "26.9.27")).toBe(true);
      const ids = new Set<string>();
      for (const release of releases) {
        expect(parseHash(changelogHref(release.version))).toEqual({
          route: "changelog",
          version: release.version,
        });
        ids.add(releaseAnchorId(release.version));
      }
      // One DOM id per release: a duplicate would make the link land on the
      // wrong entry.
      expect(ids.size).toBe(releases.length);
    }
  });
});
