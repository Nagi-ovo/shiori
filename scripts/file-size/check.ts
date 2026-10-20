// Pre-commit size gate. Reads sizes from the index (what is being committed),
// not the working tree, so partial staging is judged correctly.
//
//   bun scripts/file-size/check.ts --staged   # the hooks; exits 1 on a violation
//   bun scripts/file-size/check.ts --init     # write the first baseline from the index
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BASELINE_PATH, LIMIT_BYTES, evaluate, inScope, parseBaseline, report, tokens, type Change } from "./policy.ts";

function git(args: string[], input?: string): string {
  const r = Bun.spawnSync(["git", ...args], {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

function tryGit(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Blob sizes by object id. Ids have no newlines, so odd file names are safe.
function blobSizes(ids: string[]): number[] {
  if (ids.length === 0) return [];
  const out = git(["cat-file", "--batch-check=%(objecttype) %(objectsize)"], ids.map((id) => `${id}\n`).join(""));
  return out.trimEnd().split("\n").map((line, i) => {
    const [type, size] = line.split(" ");
    if (type !== "blob") throw new Error(`cannot size staged object ${ids[i]}: ${line}`);
    return Number(size);
  });
}

// `--raw -z`: ":oldmode newmode oldid newid status\0path\0[newpath\0]".
// T (symlink <-> file) is measured like a modification; gitlinks are not files.
// -B splits a full rewrite so a move-out pairs as a copy; B in the filter keeps
// the rewritten source, which git lists as "M100".
function stagedChanges(): Change[] {
  const fields = git(["diff", "--cached", "--raw", "-z", "-B", "-M", "--diff-filter=ACMRTDB"]).split("\0");
  const raw: { status: string; mode: string; id: string; oldPath?: string; path: string }[] = [];
  for (let i = 0; i < fields.length - 1; ) {
    const [, mode, , id, status] = fields[i++]!.split(" ") as [string, string, string, string, string];
    const s = status[0]!;
    if (s === "R" || s === "C") raw.push({ status: s, mode, id, oldPath: fields[i++]!, path: fields[i++]! });
    else raw.push({ status: s, mode, id, path: fields[i++]! });
  }
  const measured = raw.filter((c) => c.status !== "D" && c.mode !== "160000" && inScope(c.path));
  const sizes = new Map(blobSizes(measured.map((c) => c.id)).map((b, i) => [measured[i]!, b]));
  return raw.map((c): Change => {
    const bytes = sizes.get(c) ?? 0;
    if (c.status === "D") return { status: "D", path: c.path };
    if (c.status === "R" || c.status === "C") return { status: c.status, oldPath: c.oldPath!, path: c.path, bytes };
    return { status: c.status as "A" | "M" | "T", path: c.path, bytes };
  });
}

const baselineAt = (rev: string) => {
  const text = tryGit(["cat-file", "blob", `${rev}:${BASELINE_PATH}`]);
  return text === null ? null : parseBaseline(text);
};

const serialize = (b: Record<string, number>) => JSON.stringify(b, null, 2) + "\n";
const root = git(["rev-parse", "--show-toplevel"]).trim();
process.chdir(root);
const baselineFile = join(root, BASELINE_PATH);

if (process.argv.includes("--init")) {
  if (baselineAt("HEAD")) fail(`${BASELINE_PATH} is already committed; it only ever shrinks.`);
  const entries = git(["ls-files", "-s", "-z"]).split("\0").filter(Boolean).map((line) => {
    const [meta, path] = line.split("\t") as [string, string];
    const [mode, id] = meta.split(" ") as [string, string];
    return { mode, id, path };
  });
  const files = entries.filter((e) => e.mode !== "160000" && inScope(e.path));
  const sizes = blobSizes(files.map((f) => f.id));
  const baseline = Object.fromEntries(
    files.map((f, i) => [f.path, sizes[i]!] as const).filter(([, b]) => b > LIMIT_BYTES).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  writeFileSync(baselineFile, serialize(baseline));
  console.log(`Wrote ${Object.keys(baseline).length} grandfathered files to ${BASELINE_PATH}.`);
} else {
  const stagedText = tryGit(["cat-file", "blob", `:${BASELINE_PATH}`]);
  const result = evaluate({
    changes: stagedChanges(),
    headBaseline: baselineAt("HEAD"),
    stagedBaseline: stagedText === null ? null : parseBaseline(stagedText),
  });
  if (result.violations.length > 0) fail(report(result.violations));

  const next = serialize(result.baseline);
  if (next !== stagedText) {
    // `git commit <paths>` commits from a temporary index while the real one
    // stays locked, so a baseline staged here would not reach it.
    if (basename(process.env.GIT_INDEX_FILE ?? "").startsWith("next-index")) {
      fail(
        `file-size: this commit shrinks a grandfathered file, so ${BASELINE_PATH} has to change with it,\n` +
          `and a path-limited commit (git commit <paths>) cannot carry that. Stage the files with\n` +
          `\`git add <paths>\` and run \`git commit\` without paths.`,
      );
    }
    // Ask git, not a string compare: a CRLF checkout (core.autocrlf) differs
    // byte for byte from the LF blob without being an edit.
    const unstaged = Bun.spawnSync(["git", "diff", "--quiet", "--", BASELINE_PATH]).exitCode !== 0;
    if (unstaged) {
      fail(
        `file-size: ${BASELINE_PATH} has unstaged edits, and this commit needs to update it.\n` +
          `Stage them (\`git add ${BASELINE_PATH}\`) or discard them, then commit again.`,
      );
    }
    writeFileSync(baselineFile, next);
    git(["add", BASELINE_PATH]);
  }
  for (const t of result.tightened) {
    const to = t.to === null ? "under the limit, entry removed" : `${tokens(t.to).toLocaleString("en-US")} tokens`;
    console.error(`file-size: ${t.path} shrank (${tokens(t.from).toLocaleString("en-US")} -> ${to}); ${BASELINE_PATH} updated.`);
  }
}
