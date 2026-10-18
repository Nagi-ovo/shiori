// Trilingual user-facing changelogs live in /docs/changelog/{zh,en,ja}.md
// and are also rendered inside the desktop app. We import them raw and
// parse client-side so the website stays in sync without a sync script —
// a release updates the markdown, both surfaces update.
//
// Format (stable across all three files):
//
//   # <title>
//
//   ## <date-version>
//   ## <legacy-version> · <date>
//
//   > <epigraph>            (optional, one per release)
//
//   ### <group header>
//   - **<lead>** <body>
//   - **<lead>** <body>
//
//   | | <before> | <after> |   (optional GFM table; it belongs to the
//   |---|---:|---:|          bullet above it, e.g. a before/after
//   | <row> | … | … |         measurement)
//
// Group headers vary by language (en: New / Improved / Fixed / Platforms;
// zh: 新增 / 改进 / 修复 / 平台; ja: 新機能 / 改善 / 修正 / プラットフォーム).
// We render whatever the markdown says — no translation table needed.

import enRaw from "../../../docs/changelog/en.md?raw";
import zhRaw from "../../../docs/changelog/zh.md?raw";
import jaRaw from "../../../docs/changelog/ja.md?raw";
import type { Lang } from "../i18n/dict";
import {
  TABLE_DELIMITER,
  TABLE_ROW,
  joinWrapped,
  tableAlign,
  tableCells,
  type CellAlign,
} from "../../../src/release/changelogSyntax";

export type Table = {
  header: string[];
  align: CellAlign[];
  rows: string[][];
};
export type Item = { lead: string; rest: string; table?: Table };
export type Group = { kind: string; items: Item[] };
export type Release = {
  version: string;
  date: string;
  /** The release's codename line, from a `>` quote under the heading. */
  epigraph: string;
  groups: Group[];
};

const RAW: Record<Lang, string> = { en: enRaw, zh: zhRaw, ja: jaRaw };

const VERSION_RE = /^##\s+(\S+?)(?:\s*[·•]\s*(\S+))?\s*$/;
// Work that has landed but not shipped sits under this heading between
// releases (docs/changelog/README.md). The desktop app shows it — a dev
// build is that work — but the website must not advertise it as a release.
const UNRELEASED_RE = /^\[?(unreleased|未发布|未リリース)\]?$/i;
const GROUP_RE = /^###\s+(.+?)\s*$/;
// Sits between the version heading and the first group. Anything after
// the first group belongs to an item, not to the release.
const EPIGRAPH_RE = /^>\s*(.+?)\s*$/;
const ITEM_LEAD_RE = /^-\s+\*\*(.+?)\*\*\s*(.*)$/;
const ITEM_PLAIN_RE = /^-\s+(.+)$/;
export function getReleases(lang: Lang): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let group: Group | null = null;

  for (const rawLine of RAW[lang].split(/\r?\n/)) {
    const line = rawLine;
    const v = VERSION_RE.exec(line);
    if (v) {
      group = null;
      if (UNRELEASED_RE.test(v[1])) {
        // Everything until the next version heading belongs to the
        // unreleased section; with no open release it is all dropped.
        release = null;
        continue;
      }
      release = { version: v[1], date: v[2] ?? "", epigraph: "", groups: [] };
      releases.push(release);
      continue;
    }
    const epi = EPIGRAPH_RE.exec(line);
    if (epi && release && !group) {
      release.epigraph = epi[1];
      continue;
    }
    const g = GROUP_RE.exec(line);
    if (g && release) {
      group = { kind: g[1], items: [] };
      release.groups.push(group);
      continue;
    }
    // A table row: the first opens a table on the bullet above, the
    // delimiter row sets the alignment, the rest are its rows.
    if (TABLE_ROW.test(line) && group && group.items.length) {
      const last = group.items[group.items.length - 1];
      if (!last.table) {
        last.table = { header: tableCells(line), align: [], rows: [] };
      } else if (!last.table.align.length && TABLE_DELIMITER.test(line)) {
        last.table.align = tableAlign(line);
      } else {
        last.table.rows.push(tableCells(line));
      }
      continue;
    }
    const lead = ITEM_LEAD_RE.exec(line);
    if (lead && group) {
      group.items.push({ lead: lead[1], rest: lead[2].trim() });
      continue;
    }
    const plain = !lead ? ITEM_PLAIN_RE.exec(line) : null;
    if (plain && group) {
      group.items.push({ lead: "", rest: plain[1].trim() });
      continue;
    }
    // Continuation: a non-empty line under an open bullet wraps onto
    // the previous item. Markdown allows soft-wraps and the source
    // occasionally uses them.
    if (group && group.items.length && line.trim() && !line.startsWith("#")) {
      const last = group.items[group.items.length - 1];
      last.rest = joinWrapped(last.rest, line);
    }
  }

  return releases;
}
