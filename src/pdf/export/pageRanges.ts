export type ExportRange = "all" | "current" | "range";

export function selectPagesForExport<T extends { id: string }>(
  range: ExportRange,
  pages: T[],
  currentIdx: number,
  customRange: string,
): T[] {
  if (range === "all") return pages;
  if (range === "current") {
    const p = pages[currentIdx - 1];
    return p ? [p] : [];
  }
  const indices = parsePageRange(customRange, pages.length);
  return indices
    .map((i) => pages[i - 1])
    .filter((p): p is T => Boolean(p));
}

export function parsePageRange(input: string, total: number): number[] {
  const out = new Set<number>();
  for (const chunk of input.split(/[,，]/)) {
    const s = chunk.trim();
    if (!s) continue;
    const m = s.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (m) {
      const a = clampPage(Number(m[1]), total);
      const b = clampPage(Number(m[2]), total);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i);
    } else if (/^\d+$/.test(s)) {
      out.add(clampPage(Number(s), total));
    }
  }
  return [...out].sort((a, b) => a - b);
}

function clampPage(n: number, total: number): number {
  return Math.max(1, Math.min(total, n));
}
