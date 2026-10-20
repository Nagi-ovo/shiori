import { describe, expect, test } from "bun:test";
import { LIMIT_BYTES, evaluate, inScope, parseBaseline, report, type Change } from "./policy.ts";

// Ways the size gate can fail, written before the code:
// - off by one at the limit (5,000 tokens = 20,000 bytes is allowed);
// - a new or newly grown hand-written file slips through;
// - a lockfile, codegen, vendored patch, fixture or binary gets blocked;
// - a grandfathered file grows a little and nobody notices;
// - a grandfathered file shrinks but its allowance stays loose;
// - a rename or copy launders a big file past the baseline;
// - a deleted file leaves a stale allowance behind;
// - someone raises or adds a baseline entry instead of splitting;
// - a malformed baseline value (a string, NaN) silently allows anything;
// - a file whose type changed (symlink -> file) is never measured;
// - retrying a rename commit that was aborted after the hook ran is refused;
// - the result depends on the order git lists renames in (a swap, a chain,
//   a move that leaves a thin re-export at the old path).
// Index-vs-worktree reads and the real `git commit` path are in check.test.ts.

const big = LIMIT_BYTES + 1;
const ok = (changes: Change[], head?: Record<string, number>, staged = head) =>
  evaluate({ changes, headBaseline: head ?? null, stagedBaseline: staged ?? null });

describe("limit", () => {
  test("exactly 5,000 tokens passes, one byte more fails", () => {
    expect(ok([{ status: "A", path: "src/a.ts", bytes: LIMIT_BYTES }]).violations).toEqual([]);
    const r = ok([{ status: "A", path: "src/a.ts", bytes: big }]);
    expect(r.violations).toEqual([{ path: "src/a.ts", bytes: big, allowed: LIMIT_BYTES, reason: "over-limit" }]);
  });

  test("a type change (symlink to file) is measured like any modification", () => {
    expect(ok([{ status: "T", path: "src/a.ts", bytes: big }]).violations).toHaveLength(1);
  });

  test("a modified file that was under the limit is held to the limit", () => {
    expect(ok([{ status: "M", path: "src-tauri/src/x.rs", bytes: big }]).violations).toHaveLength(1);
  });

  test("every offending file is reported, not just the first", () => {
    const r = ok([
      { status: "A", path: "src/a.ts", bytes: big },
      { status: "M", path: "cli/src/b.ts", bytes: big + 10 },
    ]);
    expect(r.violations.map((v) => v.path)).toEqual(["src/a.ts", "cli/src/b.ts"]);
  });
});

describe("scope", () => {
  test.each([
    "src/editor/store/store.ts",
    "src/editor/components/Canvas.tsx",
    "crates/shiori-core/src/lib.rs",
    "cli/installer/install.sh",
    "cli/installer/install.ps1",
    ".github/workflows/release.yml",
    "src/app.css",
    "src-tauri/gen/android/app/src/main/java/fun/nagi/shiori/MainActivity.kt",
  ])("hand-written code is checked: %s", (path) => {
    expect(inScope(path)).toBe(true);
  });

  test.each([
    "bun.lock",
    "src-tauri/Cargo.lock",
    "docs/POSTMORTEMS.md",
    "CHANGELOG.md",
    "src/i18n/locales/ja.json",
    "src-tauri/gen/apple/shiori.xcodeproj/project.pbxproj",
    "src-tauri/gen/android/buildSrc/src/main/java/fun/nagi/shiori/kotlin/RustPlugin.kt",
    "src-tauri/patches/tao-0.35.3/src/platform_impl/windows/window.rs",
    "site/public/cli.sh",
    "site/public/cli.ps1",
    "src/platform/bindings.ts",
    "src-tauri/gen/android/app/src/main/java/fun/nagi/shiori/generated/Ipc.kt",
    "src/pdf/export/__fixtures__/forms.ts",
    "crates/shiori-core/tests/fixtures/fonts/big.rs",
    "vendor/tools/wasm-bindgen.js",
    "src/assets/fonts/NotoSansSC-Regular.otf",
    ".github/readme/screenshots/home.png",
  ])("lockfiles, docs, codegen, vendored and binary files are skipped: %s", (path) => {
    expect(inScope(path)).toBe(false);
    expect(ok([{ status: "A", path, bytes: big * 10 }]).violations).toEqual([]);
  });
});

describe("grandfathered files", () => {
  const head = { "src/editor/store/store.ts": 75_000 };

  test("may stay the same size", () => {
    const r = ok([{ status: "M", path: "src/editor/store/store.ts", bytes: 75_000 }], head);
    expect(r.violations).toEqual([]);
    expect(r.baseline).toEqual(head);
    expect(r.tightened).toEqual([]);
  });

  test("may not grow, even by one byte", () => {
    const r = ok([{ status: "M", path: "src/editor/store/store.ts", bytes: 75_001 }], head);
    expect(r.violations).toEqual([
      { path: "src/editor/store/store.ts", bytes: 75_001, allowed: 75_000, reason: "grew" },
    ]);
  });

  test("shrinking tightens the allowance to the new size", () => {
    const r = ok([{ status: "M", path: "src/editor/store/store.ts", bytes: 60_000 }], head);
    expect(r.violations).toEqual([]);
    expect(r.baseline).toEqual({ "src/editor/store/store.ts": 60_000 });
    expect(r.tightened).toEqual([{ path: "src/editor/store/store.ts", from: 75_000, to: 60_000 }]);
  });

  test("dropping under the limit removes the entry for good", () => {
    const r = ok([{ status: "M", path: "src/editor/store/store.ts", bytes: 9_000 }], head);
    expect(r.baseline).toEqual({});
    expect(r.tightened).toEqual([{ path: "src/editor/store/store.ts", from: 75_000, to: null }]);
  });

  test("deleting the file removes its entry", () => {
    const r = ok([{ status: "D", path: "src/editor/store/store.ts" }], head);
    expect(r.violations).toEqual([]);
    expect(r.baseline).toEqual({});
  });

  test("files that are not staged keep their entries untouched", () => {
    const r = ok([{ status: "A", path: "src/new.ts", bytes: 100 }], head);
    expect(r.baseline).toEqual(head);
    expect(r.tightened).toEqual([]);
  });
});

describe("renames and copies", () => {
  const head = { "src/old.ts": 30_000 };

  test("a pure rename carries the allowance to the new path", () => {
    const r = ok([{ status: "R", oldPath: "src/old.ts", path: "src/new.ts", bytes: 30_000 }], head);
    expect(r.violations).toEqual([]);
    expect(r.baseline).toEqual({ "src/new.ts": 30_000 });
  });

  test("a rename that also grows the file fails against the old allowance", () => {
    const r = ok([{ status: "R", oldPath: "src/old.ts", path: "src/new.ts", bytes: 30_500 }], head);
    expect(r.violations).toEqual([{ path: "src/new.ts", bytes: 30_500, allowed: 30_000, reason: "grew" }]);
  });

  test("a copy of a grandfathered file is a new file and must fit the limit", () => {
    const r = ok([{ status: "C", oldPath: "src/old.ts", path: "src/copy.ts", bytes: 30_000 }], head);
    expect(r.violations).toEqual([{ path: "src/copy.ts", bytes: 30_000, allowed: LIMIT_BYTES, reason: "over-limit" }]);
    expect(r.baseline).toEqual(head);
  });

  test("retrying a rename after an aborted commit accepts the carried allowance", () => {
    // The first attempt already staged the baseline with the entry moved.
    const r = ok([{ status: "R", oldPath: "src/old.ts", path: "src/new.ts", bytes: 30_000 }], head, {
      "src/new.ts": 30_000,
    });
    expect(r.violations).toEqual([]);
    expect(r.baseline).toEqual({ "src/new.ts": 30_000 });
  });

  test.each([false, true])("a swap of two grandfathered files keeps each allowance (reversed: %s)", (reversed) => {
    const both = { "src/a.ts": 50_000, "src/b.ts": 30_000 };
    const changes: Change[] = [
      { status: "R", oldPath: "src/a.ts", path: "src/b.ts", bytes: 50_000 },
      { status: "R", oldPath: "src/b.ts", path: "src/a.ts", bytes: 35_000 },
    ];
    const r = ok(reversed ? changes.reverse() : changes, both);
    expect(r.violations).toEqual([{ path: "src/a.ts", bytes: 35_000, allowed: 30_000, reason: "grew" }]);
    expect(r.baseline).toEqual({ "src/a.ts": 30_000, "src/b.ts": 50_000 });
  });

  test.each([false, true])("moving a file out and leaving a thin re-export works in either order (reversed: %s)", (reversed) => {
    const changes: Change[] = [
      { status: "R", oldPath: "src/old.ts", path: "src/old/impl.ts", bytes: 29_000 },
      { status: "A", path: "src/old.ts", bytes: 200 },
    ];
    const r = ok(reversed ? changes.reverse() : changes, head);
    expect(r.violations).toEqual([]);
    expect(r.baseline).toEqual({ "src/old/impl.ts": 29_000 });
  });

  test.each([false, true])("a move reported as a copy plus a rewrite of the source carries the allowance (reversed: %s)", (reversed) => {
    // `git diff -B -M` lists a file moved out with a re-export left behind as C + M.
    const changes: Change[] = [
      { status: "M", path: "src/old.ts", bytes: 200 },
      { status: "C", oldPath: "src/old.ts", path: "src/old/impl.ts", bytes: 30_000 },
    ];
    const r = ok(reversed ? changes.reverse() : changes, head);
    expect(r.violations).toEqual([]);
    expect(r.baseline).toEqual({ "src/old/impl.ts": 30_000 });
  });

  test("a copy does not carry the allowance while the source stays big", () => {
    const r = ok(
      [
        { status: "M", path: "src/old.ts", bytes: 29_000 },
        { status: "C", oldPath: "src/old.ts", path: "src/old/impl.ts", bytes: 30_000 },
      ],
      head,
    );
    expect(r.violations.map((v) => v.path)).toEqual(["src/old/impl.ts"]);
  });

  test("renaming into an excluded path drops the entry", () => {
    const r = ok(
      [{ status: "R", oldPath: "src/old.ts", path: "src/pdf/export/__fixtures__/old.ts", bytes: 30_000 }],
      head,
    );
    expect(r.violations).toEqual([]);
    expect(r.baseline).toEqual({});
  });
});

describe("the baseline itself", () => {
  const head = { "src/a.ts": 30_000 };

  test("raising an entry is refused and names the entry", () => {
    const r = ok([{ status: "M", path: "src/a.ts", bytes: 31_000 }], head, { "src/a.ts": 31_000 });
    expect(r.violations).toContainEqual({ path: "src/a.ts", bytes: 31_000, allowed: 30_000, reason: "baseline-raised" });
    expect(r.violations.map((v) => v.reason)).toContain("grew");
    expect(r.baseline).toEqual(head);
  });

  test("adding an entry is refused", () => {
    const r = ok([{ status: "A", path: "src/b.ts", bytes: 25_000 }], head, { ...head, "src/b.ts": 25_000 });
    expect(r.violations.map((v) => v.reason).sort()).toEqual(["baseline-raised", "over-limit"]);
    expect(r.baseline).toEqual(head);
  });

  test("lowering an entry by hand is kept", () => {
    const r = ok([], head, { "src/a.ts": 25_000 });
    expect(r.violations).toEqual([]);
    expect(r.baseline).toEqual({ "src/a.ts": 25_000 });
  });

  test("the first commit that adds the baseline grandfathers what it lists", () => {
    const r = ok([{ status: "M", path: "src/a.ts", bytes: 30_000 }], undefined, { "src/a.ts": 30_000 });
    expect(r.violations).toEqual([]);
    expect(r.baseline).toEqual({ "src/a.ts": 30_000 });
  });
});

describe("parsing the baseline", () => {
  test("accepts an object of whole byte counts", () => {
    expect(parseBaseline('{"src/a.ts": 30000}')).toEqual({ "src/a.ts": 30_000 });
  });

  test.each(['{"src/a.ts": "30,000"}', '{"src/a.ts": -1}', '{"src/a.ts": 1.5}', '{"src/a.ts": null}', "[30000]", "30000"])(
    "rejects anything else rather than letting it allow growth: %s",
    (text) => {
      expect(() => parseBaseline(text)).toThrow();
    },
  );
});

describe("the failure message", () => {
  test("shows bytes when two sizes round to the same token count", () => {
    const text = report([{ path: "src/a.ts", bytes: 75_599, allowed: 75_598, reason: "grew" }]);
    expect(text).toContain("75,599 bytes");
    expect(text).toContain("75,598 bytes");
  });
});
