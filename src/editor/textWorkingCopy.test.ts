import { describe, expect, test } from "bun:test";
import type { RecentEntry } from "./recentDocs";
import { findTextWorkingCopyRecent } from "./textWorkingCopy";

const recents: RecentEntry[] = [
  {
    name: "notes.md",
    pages: 0,
    size: 12,
    savedAt: 1,
    kind: "markdown",
    path: "/docs/notes.md",
    cacheId: "working-path",
  },
  {
    name: "web.md",
    pages: 0,
    size: 14,
    savedAt: 2,
    kind: "markdown",
    webFileHandleId: "handle-web",
    cacheId: "working-web",
  },
];

describe("findTextWorkingCopyRecent", () => {
  test("restores the working copy when the same path is opened again", () => {
    expect(
      findTextWorkingCopyRecent("markdown", { path: "/docs/notes.md" }, recents)
        ?.cacheId,
    ).toBe("working-path");
  });

  test("restores the working copy when the same file handle is opened again", () => {
    expect(
      findTextWorkingCopyRecent(
        "markdown",
        { webFileHandleId: "handle-web" },
        recents,
      )?.cacheId,
    ).toBe("working-web");
  });

  test("does not replace an explicitly cache-backed payload", () => {
    expect(
      findTextWorkingCopyRecent(
        "markdown",
        { path: "/docs/notes.md", cacheId: "selected-cache" },
        recents,
      ),
    ).toBeNull();
  });
});
