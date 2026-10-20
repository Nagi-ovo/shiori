import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_PATH, LIMIT_BYTES } from "./policy.ts";

// Drives the real hook through `git commit` in a scratch repository, because
// what matters is what the index holds, not what the working tree shows.

const repoRoot = join(import.meta.dir, "../..");
const repos: string[] = [];

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function scratchRepo(baseline: Record<string, number> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shiori-file-size-"));
  repos.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "scripts/file-size"), { recursive: true });
  for (const f of ["check.ts", "policy.ts"]) {
    cpSync(join(repoRoot, "scripts/file-size", f), join(dir, "scripts/file-size", f));
  }
  cpSync(join(repoRoot, ".githooks"), join(dir, ".githooks"), { recursive: true });
  for (const hook of ["pre-commit", "pre-merge-commit"]) chmodSync(join(dir, ".githooks", hook), 0o755);
  writeFileSync(join(dir, BASELINE_PATH), JSON.stringify(baseline, null, 2) + "\n");
  for (const path of Object.keys(baseline)) write(dir, path, baseline[path]!);
  git(dir, "add", "-A");
  expect(git(dir, "commit", "-q", "--no-verify", "-m", "seed").code).toBe(0);
  git(dir, "config", "core.hooksPath", ".githooks");
  return dir;
}

function write(dir: string, path: string, bytes: number) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), "x".repeat(bytes));
}

const committed = (dir: string, path: string) => git(dir, "show", `HEAD:${path}`).out;

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pre-commit hook", () => {
  test("refuses a new file over 5,000 tokens and says how to split it", () => {
    const dir = scratchRepo();
    write(dir, "src/huge.ts", LIMIT_BYTES + 1);
    git(dir, "add", "src/huge.ts");
    const r = git(dir, "commit", "-q", "-m", "add huge");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("src/huge.ts");
    expect(r.err).toContain("5,001 tokens");
    expect(r.err).toMatch(/how to split/i);
    expect(git(dir, "log", "--oneline").out.trim().split("\n")).toHaveLength(1);
  });

  test("measures the staged blob, not the working tree", () => {
    const dir = scratchRepo();
    write(dir, "src/a.ts", 100);
    git(dir, "add", "src/a.ts");
    write(dir, "src/a.ts", LIMIT_BYTES * 3);
    expect(git(dir, "commit", "-q", "-m", "small staged").code).toBe(0);

    git(dir, "add", "src/a.ts");
    write(dir, "src/a.ts", 100);
    expect(git(dir, "commit", "-q", "-m", "big staged").code).not.toBe(0);
  });

  test("ignores staged files outside its scope", () => {
    const dir = scratchRepo();
    write(dir, "bun.lock", LIMIT_BYTES * 5);
    write(dir, "docs/NOTES.md", LIMIT_BYTES * 5);
    git(dir, "add", "-A");
    expect(git(dir, "commit", "-q", "-m", "data").code).toBe(0);
  });

  test("lets a grandfathered file shrink and commits the tighter baseline with it", () => {
    const dir = scratchRepo({ "src/store.ts": 30_000 });
    write(dir, "src/store.ts", 25_000);
    git(dir, "add", "src/store.ts");
    const r = git(dir, "commit", "-q", "-m", "trim store");
    expect(r.code).toBe(0);
    expect(JSON.parse(committed(dir, BASELINE_PATH))).toEqual({ "src/store.ts": 25_000 });
    expect(git(dir, "status", "--porcelain").out).toBe("");
  });

  test("blocks a grandfathered file from growing", () => {
    const dir = scratchRepo({ "src/store.ts": 30_000 });
    write(dir, "src/store.ts", 30_040);
    git(dir, "add", "src/store.ts");
    const r = git(dir, "commit", "-q", "-m", "grow store");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("src/store.ts");
  });

  test("follows a git mv of a grandfathered file", () => {
    const dir = scratchRepo({ "src/store.ts": 30_000 });
    mkdirSync(join(dir, "src/editor"));
    expect(git(dir, "mv", "src/store.ts", "src/editor/store.ts").code).toBe(0);
    expect(git(dir, "commit", "-q", "-m", "move store").code).toBe(0);
    expect(JSON.parse(committed(dir, BASELINE_PATH))).toEqual({ "src/editor/store.ts": 30_000 });
  });

  test("measures a file whose name contains a newline", () => {
    const dir = scratchRepo();
    write(dir, "src/a\nb.ts", LIMIT_BYTES + 1);
    git(dir, "add", "-A");
    const r = git(dir, "commit", "-q", "-m", "odd name");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("5,001 tokens");
  });

  test("measures a symlink that became a big regular file", () => {
    const dir = scratchRepo();
    symlinkSync("target.ts", join(dir, "src-link.ts"));
    git(dir, "add", "-A");
    expect(git(dir, "commit", "-q", "-m", "link").code).toBe(0);
    rmSync(join(dir, "src-link.ts"));
    write(dir, "src-link.ts", LIMIT_BYTES + 1);
    git(dir, "add", "-A");
    expect(git(dir, "commit", "-q", "-m", "now a file").code).not.toBe(0);
  });

  test("checks a merge that grows a file past the limit", () => {
    const dir = scratchRepo();
    // 100 lines of 190 bytes; each side adds 800 bytes far from the other.
    const base = Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(189, "x")).join("\n") + "\n";
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), base);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "src/a.ts"), base + "y".repeat(799) + "\n");
    git(dir, "commit", "-q", "-am", "side grows the end");
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "src/a.ts"), "z".repeat(799) + "\n" + base);
    git(dir, "commit", "-q", "-am", "main grows the start");
    const r = git(dir, "merge", "-q", "--no-edit", "side");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("src/a.ts");
  });

  test("refuses to tighten the baseline in a path-limited commit and says what to do", () => {
    const dir = scratchRepo({ "src/store.ts": 30_000 });
    write(dir, "src/store.ts", 25_000);
    const r = git(dir, "commit", "-q", "-m", "trim", "src/store.ts");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("git add");
    git(dir, "add", "src/store.ts");
    expect(git(dir, "commit", "-q", "-m", "trim").code).toBe(0);
    expect(git(dir, "status", "--porcelain").out).toBe("");
  });

  test("does not overwrite unstaged edits to the baseline", () => {
    const dir = scratchRepo({ "src/store.ts": 30_000 });
    const mine = JSON.stringify({ "src/store.ts": 24_000 }) + "\n";
    writeFileSync(join(dir, BASELINE_PATH), mine);
    write(dir, "src/store.ts", 25_000);
    git(dir, "add", "src/store.ts");
    expect(git(dir, "commit", "-q", "-m", "trim").code).not.toBe(0);
    expect(readFileSync(join(dir, BASELINE_PATH), "utf8")).toBe(mine);
  });
});
