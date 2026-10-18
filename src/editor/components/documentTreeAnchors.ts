import type { Overlay, PageModel } from "../../pdf/model/types";

export type DocumentTreeAnchor = {
  id: string;
  /** 1-based display page — what the reader sees and what we scroll to. */
  page: number;
  /** One row's worth: the body (or anchored quote) clipped to a single line. */
  label: string;
  /**
   * The same text, clipped far less, for the hover preview. A row ends in an
   * ellipsis precisely when the reader most wants the rest, and `label` was
   * already cut at the data layer — so a tooltip over it would have shown the
   * same truncated string the row did.
   */
  preview: string;
  /** Set when `preview` is itself clipped, so the popover can say so. */
  previewClipped?: boolean;
  /** Conversation turns on a callout, so the preview can note the thread. */
  threadTurns?: number;
  kind: string;
};

/** One tree row's worth of text; longer bodies are a document, not a label. */
const ANCHOR_LABEL_MAX = 120;
/**
 * The preview's own ceiling. Generous — it is a popover, not a row — but not
 * unbounded: a callout can hold a page of text, and a popover taller than the
 * panel is worse than a clipped one.
 */
const ANCHOR_PREVIEW_MAX = 1_200;

/**
 * The marks worth listing under a document: anything that says something. An
 * ink stroke or a stamp has no label a reader would recognize in a list, so
 * it stays on the page rather than becoming a blank row.
 *
 * Ordered by page — an outline follows reading order, not creation order,
 * which is what makes it usable as a table of contents.
 */
export function documentTreeAnchors(
  overlays: readonly Overlay[],
  pages: readonly PageModel[],
): DocumentTreeAnchor[] {
  const pageNumbers = new Map<string, number>();
  pages.forEach((page, index) => pageNumbers.set(page.id, index + 1));
  const anchors: DocumentTreeAnchor[] = [];
  for (const overlay of overlays) {
    const page = pageNumbers.get(overlay.pageId);
    if (page === undefined) continue;
    const body =
      "text" in overlay && typeof overlay.text === "string" ? overlay.text : "";
    // Body first, anchored quote as the fallback: a highlight has no body of
    // its own, and the sentence it sits on is the only honest name for it.
    const full = (body.trim() || overlay.anchor?.quote?.trim() || "").replace(
      /\s+/g,
      " ",
    );
    if (!full) continue;
    const turns =
      overlay.type === "callout" ? overlay.thread?.length ?? 0 : 0;
    anchors.push({
      id: overlay.id,
      page,
      label: full.slice(0, ANCHOR_LABEL_MAX),
      preview: full.slice(0, ANCHOR_PREVIEW_MAX),
      ...(full.length > ANCHOR_PREVIEW_MAX ? { previewClipped: true } : {}),
      ...(turns > 0 ? { threadTurns: turns } : {}),
      kind: overlay.type,
    });
  }
  return anchors.sort((a, b) => a.page - b.page);
}

/**
 * The folder a document sits in, short enough for a 230px gutter: the parent
 * directory's own name, with a leading ellipsis when there is more path above
 * it. The full path stays in the row's tooltip.
 *
 * The first cut printed the whole path and leaned on `direction: rtl` to clip
 * it from the left. That reordered the string instead of clipping it — the
 * leading slash surfaced at the END of the line and the filename appeared a
 * second time, right under the title that already showed it. A folder name is
 * all this line was ever for: telling two same-named papers apart.
 */
/**
 * Is `path` inside `folder`? Separator-agnostic on purpose: both strings come
 * from Rust's `to_string_lossy()` on a native path, so on Windows both are
 * backslash-separated and a hardcoded `${folder}/` prefix test never matched —
 * every file under a mounted folder was listed twice, once in the folder tree
 * and again under "unfiled".
 *
 * Compared segment-wise rather than by string prefix so that a sibling folder
 * sharing a name prefix (`/Papers2/a.pdf` against `/Papers`) is not counted as
 * inside. Windows paths are matched case-insensitively, which is how its file
 * system treats them.
 */
export function isPathInsideFolder(
  path: string | undefined,
  folder: string | undefined,
): boolean {
  if (!path || !folder) return false;
  // A backslash alone does not make a path a Windows path — it is a legal
  // character in a POSIX filename, and treating `/tmp/Papers\Archive/a.pdf`
  // as three segments would wrongly place it inside `/tmp/Papers`. Only a
  // drive letter or a UNC prefix decides it.
  const windowsLike = (value: string) =>
    /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
  const windows = windowsLike(folder) || windowsLike(path);
  const normalize = (value: string) => {
    const segments = windows
      ? value.split(/[\\/]+/).filter(Boolean)
      : value.split("/").filter(Boolean);
    return windows ? segments.map((s) => s.toLowerCase()) : segments;
  };
  const folderSegments = normalize(folder);
  const pathSegments = normalize(path);
  if (folderSegments.length === 0) return false;
  // Strictly inside: the path must have something of its own below the folder.
  if (pathSegments.length <= folderSegments.length) return false;
  return folderSegments.every((segment, i) => pathSegments[i] === segment);
}

export function documentTreeFolder(path: string | undefined): string | null {
  if (!path) return null;
  const separator = path.includes("\\") ? "\\" : "/";
  const segments = path.split(/[\\/]+/).filter(Boolean);
  // Last segment is the file itself; the one before it is the folder.
  if (segments.length < 2) return null;
  const folder = segments[segments.length - 2];
  if (!folder) return null;
  const hasMoreAbove =
    segments.length > 2 || path.startsWith(separator) || path.startsWith("/");
  return hasMoreAbove ? `…${separator}${folder}` : folder;
}
