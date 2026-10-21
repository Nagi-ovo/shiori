import type { ExportMode, ExportQuality } from "../../pdf/export/exportPdf";

export type QualityV = ExportQuality;

// Remember the annotation mode + quality across exports (WCAG 2.2 SC 3.3.7,
// redundant entry). The page range is intentionally NOT persisted — it is
// document-specific. Stored as one small JSON blob, validated on read so a
// stale/garbage value can never wedge the dialog.
const EXPORT_PREFS_KEY = "shiori:exportPrefs:v1";
const EXPORT_MODES: readonly ExportMode[] = ["annotations", "flatten", "none"];
export const EXPORT_QUALITIES: readonly QualityV[] = [
  "original",
  "standard",
  "compact",
];
const DEFAULT_EXPORT_PREFS: { mode: ExportMode; quality: QualityV } = {
  mode: "annotations",
  quality: "original",
};

export function readExportPrefs(): { mode: ExportMode; quality: QualityV } {
  try {
    const raw = localStorage.getItem(EXPORT_PREFS_KEY);
    if (!raw) return DEFAULT_EXPORT_PREFS;
    const parsed = JSON.parse(raw) as { mode?: unknown; quality?: unknown };
    return {
      mode: EXPORT_MODES.includes(parsed.mode as ExportMode)
        ? (parsed.mode as ExportMode)
        : DEFAULT_EXPORT_PREFS.mode,
      quality: EXPORT_QUALITIES.includes(parsed.quality as QualityV)
        ? (parsed.quality as QualityV)
        : DEFAULT_EXPORT_PREFS.quality,
    };
  } catch {
    return DEFAULT_EXPORT_PREFS;
  }
}

export function writeExportPrefs(mode: ExportMode, quality: QualityV): void {
  try {
    localStorage.setItem(EXPORT_PREFS_KEY, JSON.stringify({ mode, quality }));
  } catch {
    // Private mode / quota — remembering preferences is best-effort.
  }
}
