#!/usr/bin/env bun
// Stamps the release codename and builds the release notes payload, so
// neither is a judgement call on release day.
//
//   bun run scripts/prepare-release-notes.ts [--version 26.9.7]
//     [--pages ../shiori-pages] [--dry]
//
// What it does, all idempotent — running it twice changes nothing:
//   1. takes the first unused entry in src/release/epigraphs.ts and
//      writes the release version onto it;
//   2. inserts `> <codename>` under that version's heading in each of
//      docs/changelog/{zh,en,ja}.md;
//   3. writes notes/<version>.json — the {en, zh, ja} payload the in-app
//      update notice fetches from updates.shiori.nagi.fun — into the
//      gh-pages checkout given by --pages (default ../shiori-pages, a
//      `git worktree add ../shiori-pages gh-pages` beside this repo).
//
// It does NOT tag, build, commit, or push anything.

import { join, resolve } from "node:path";

import {
  EPIGRAPHS,
  LOW_WATER_MARK,
  formatEpigraph,
} from "../src/release/epigraphs.ts";
import {
  changelogSectionToMarkdown,
  changelogSectionToNotes,
  sectionOf,
} from "../src/release/notes.ts";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const versionArg = args.indexOf("--version");
const version =
  versionArg !== -1
    ? args[versionArg + 1]
    : JSON.parse(await Bun.file("package.json").text()).version;

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error(`Not a version: ${version}`);
  process.exit(1);
}

// The updater manifest and notes are served by GitHub Pages from the
// gh-pages branch. Checked before anything is written, so a missing or
// wrong checkout stops the run instead of leaving a half-stamped release.
const pagesArg = args.indexOf("--pages");
const pagesDir = resolve(pagesArg !== -1 ? (args[pagesArg + 1] ?? "") : "../shiori-pages");
if (!dry) {
  const head = Bun.spawnSync({
    cmd: ["git", "-C", pagesDir, "symbolic-ref", "--short", "HEAD"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const branch = head.exitCode === 0 ? new TextDecoder().decode(head.stdout).trim() : null;
  if (branch !== "gh-pages") {
    console.error(
      `${pagesDir} is not a checkout of the gh-pages branch (${branch ?? "detached HEAD or not a Git checkout"}). ` +
        "Create it with `git worktree add ../shiori-pages gh-pages`, or pass --pages <dir>.",
    );
    process.exit(1);
  }
}

const LANGS = ["zh", "en", "ja"] as const;
type Lang = (typeof LANGS)[number];
const HEADINGS: Record<Lang, string> = {
  zh: "更新日志",
  en: "What's new",
  ja: "更新情報",
};

// ---------------------------------------------------------------- epigraph

let epigraph = EPIGRAPHS.find((e) => e.version === version);
if (!epigraph) {
  epigraph = EPIGRAPHS.find((e) => !e.version);
  if (!epigraph) {
    console.error(
      "The epigraph pool is spent. Add a new season to src/release/epigraphs.ts before releasing.",
    );
    process.exit(1);
  }
  const source = "src/release/epigraphs.ts";
  const text = await Bun.file(source).text();
  // One entry per line, `version` always last in the object literal.
  const line = new RegExp(
    `(\\{ episode: ${epigraph.episode}, ja: "${epigraph.ja}", zh: "${epigraph.zh}", en: "${epigraph.en}")( \\})`,
  );
  if (!line.test(text)) {
    console.error(`Could not find episode ${epigraph.episode} in ${source}.`);
    process.exit(1);
  }
  const stamped = text.replace(line, `$1, version: "${version}"$2`);
  if (dry) console.log(`[dry] would stamp ${epigraph.ja} with ${version}`);
  else await Bun.write(source, stamped);
}

const remaining =
  EPIGRAPHS.filter((e) => !e.version && e !== epigraph).length;
if (remaining <= LOW_WATER_MARK) {
  console.warn(
    `WARNING: ${remaining} epigraph(s) left after this release. Curate the next season.`,
  );
}

// --------------------------------------------------------------- changelog

for (const lang of LANGS) {
  const path = `docs/changelog/${lang}.md`;
  const text = await Bun.file(path).text();
  const section = sectionOf(text, version);
  if (!section) {
    console.error(`${path} has no "## ${version}" section yet.`);
    process.exit(1);
  }
  const quote = `> ${formatEpigraph(epigraph, lang)}`;
  if (section.lines.some((l) => l.trim() === quote)) continue;
  if (section.lines.some((l) => l.trimStart().startsWith(">"))) {
    console.error(`${path} already carries a different epigraph for ${version}.`);
    process.exit(1);
  }
  const lines = text.split("\n");
  lines.splice(section.start + 1, 0, "", quote);
  if (dry) console.log(`[dry] would insert "${quote}" into ${path}`);
  else await Bun.write(path, lines.join("\n"));
}

// ------------------------------------------------------------------- notes

const notes = {} as Record<Lang, string>;
const markdown = {} as Record<Lang, string>;
for (const lang of LANGS) {
  const text = await Bun.file(`docs/changelog/${lang}.md`).text();
  if (!text.includes(`# ${HEADINGS[lang]}`)) {
    console.error(`docs/changelog/${lang}.md does not look like the ${lang} changelog.`);
    process.exit(1);
  }
  notes[lang] = changelogSectionToNotes(text, version);
  markdown[lang] = changelogSectionToMarkdown(text, version);
  if (!notes[lang]) {
    console.error(`No entries under "## ${version}" in docs/changelog/${lang}.md.`);
    process.exit(1);
  }
}

// The top-level strings are plain text for update notices up to 26.9.26,
// which turn every non-bullet line into a heading. `markdown` is the
// changelog section itself for later notices, which render it with the
// in-app changelog's renderer; older ones never read it.
const payload = `${JSON.stringify(
  {
    en: notes.en,
    zh: notes.zh,
    ja: notes.ja,
    markdown: { en: markdown.en, zh: markdown.zh, ja: markdown.ja },
  },
  null,
  2,
)}\n`;
if (dry) {
  console.log(payload);
} else {
  const target = join(pagesDir, "notes", `${version}.json`);
  await Bun.write(target, payload);
  console.log(`Wrote ${target}`);
}

console.log(
  `${dry ? "[dry] " : ""}${version} · ${epigraph.zh} / ${epigraph.en} · ${remaining} epigraph(s) left`,
);
