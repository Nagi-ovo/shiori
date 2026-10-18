// Turns one version's section of a user-facing changelog into the plain
// text that ships as release notes: the GitHub release body, and the
// `notes/<version>.json` payload the in-app update notice renders.
//
// Both of those surfaces render plain text, not markdown, so the bold
// leads and `###` group headings have to be flattened rather than passed
// through. `scripts/prepare-release-notes.ts` is the only caller; the
// logic lives here so it can be tested.

import {
  CJK,
  TABLE_DELIMITER,
  TABLE_ROW,
  joinWrapped,
  tableCells,
} from "./changelogSyntax";

/**
 * One table body row as a sub-item: "Memory at high zoom: 252–259 MB →
 * 106 MB". The header row is dropped; the arrow carries before → after.
 */
function tableRowToText(line: string): string {
  const [label = "", ...values] = tableCells(line);
  const colon = CJK.test(label) ? "：" : ": ";
  return `${label}${colon}${values.join(" → ")}`;
}

export type ChangelogSection = {
  /** Index of the `## <version>` line. */
  start: number;
  /** Index one past the last line of the section. */
  end: number;
  /** The section's lines, heading excluded. */
  lines: string[];
};

export function sectionOf(
  markdown: string,
  version: string,
): ChangelogSection | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return { start, end, lines: lines.slice(start + 1, end) };
}

/**
 * A version's changelog section as markdown, for readers that render it
 * with the in-app changelog's own renderer (update notices after 26.9.26):
 * nothing is flattened, so tables and bold leads survive. The epigraph
 * quote is dropped, as in the plain-text notes.
 */
export function changelogSectionToMarkdown(
  markdown: string,
  version: string,
): string {
  const section = sectionOf(markdown, version);
  if (!section) return "";
  return section.lines
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim();
}

/**
 * Flatten a version's changelog section to release-note text. Group
 * headings become bare lines separated by a blank line, entries become
 * `•` bullets, the epigraph quote is dropped (it is rendered on its own
 * elsewhere), and a soft-wrapped entry is folded back together before
 * its bold markers come off — otherwise a lead that spans two source
 * lines leaves a stray `**` mid-sentence.
 */
export function changelogSectionToNotes(
  markdown: string,
  version: string,
): string {
  const section = sectionOf(markdown, version);
  if (!section) return "";

  const blocks: { kind: "group" | "entry" | "row"; text: string }[] = [];
  let tableHeaderSeen = false;
  for (const raw of section.lines) {
    const line = raw.trim();
    if (!line || line.startsWith(">")) continue;
    // A table under an entry (the before/after perf table). Readers include
    // the update notice of the version being replaced, which turns any line
    // that is not a bullet into a heading, so each body row becomes an
    // indented `◦` sub-item that old and new renderers both list.
    if (TABLE_ROW.test(line)) {
      if (TABLE_DELIMITER.test(line)) continue;
      if (!tableHeaderSeen) tableHeaderSeen = true;
      else blocks.push({ kind: "row", text: tableRowToText(line) });
      continue;
    }
    tableHeaderSeen = false;
    const group = /^###\s+(.+)$/.exec(line);
    if (group) {
      blocks.push({ kind: "group", text: group[1]! });
      continue;
    }
    const bullet = /^-\s+(.+)$/.exec(line);
    if (bullet) {
      blocks.push({ kind: "entry", text: bullet[1]! });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "entry") last.text = joinWrapped(last.text, line);
  }

  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === "group") {
      if (out.length) out.push("");
      out.push(block.text);
      continue;
    }
    if (block.kind === "row") {
      out.push(`  ◦ ${block.text}`);
      continue;
    }
    const lead = /^\*\*(.+?)\*\*\s*(.*)$/.exec(block.text);
    const text = lead
      ? joinWrapped(lead[1]!, lead[2]!)
      : block.text.replace(/\*\*/g, "");
    out.push(`• ${text}`);
  }
  return out.join("\n");
}
