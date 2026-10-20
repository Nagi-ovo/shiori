import type {
  DocumentModel,
  Overlay,
  PageModel,
  PdfPoint,
  PdfRect,
} from "../pdf/model/types";
import type {
  HistoryEntry,
  OverlayBatchHistoryEntry,
} from "../editor/store/store";
import { isSha256Hex } from "../live/liveReceiptPolicy";

// Shape checks for undo history read back from a persisted draft.

const HISTORY_ID_MAX_CHARS = 256;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= HISTORY_ID_MAX_CHARS
  );
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_RE.test(value);
}

function isPdfPoint(value: unknown): value is PdfPoint {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isPdfRect(value: unknown): value is PdfRect {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.w) &&
    value.w > 0 &&
    isFiniteNumber(value.h) &&
    value.h > 0
  );
}

function isPageModel(value: unknown): value is PageModel {
  if (!isRecord(value)) return false;
  return (
    isBoundedId(value.id) &&
    isSafeInteger(value.sourceIndex) &&
    (value.rotation === 0 ||
      value.rotation === 90 ||
      value.rotation === 180 ||
      value.rotation === 270) &&
    isOptionalFiniteNumber(value.originXPt) &&
    isOptionalFiniteNumber(value.originYPt) &&
    isFiniteNumber(value.widthPt) &&
    value.widthPt > 0 &&
    isFiniteNumber(value.heightPt) &&
    value.heightPt > 0 &&
    (value.blank === undefined || typeof value.blank === "boolean")
  );
}

function hasValidOverlayCommon(value: Record<string, unknown>): boolean {
  return (
    isBoundedId(value.id) &&
    isBoundedId(value.pageId) &&
    (value.locked === undefined || typeof value.locked === "boolean") &&
    hasValidSourceProvenance(value)
  );
}

// Optional review provenance copied from an imported annotation. Absent on
// every overlay Shiori authored, and absent from drafts written before the
// fields existed — so each check has to tolerate undefined.
function hasValidSourceProvenance(value: Record<string, unknown>): boolean {
  return (
    (value.sourceAuthor === undefined ||
      (typeof value.sourceAuthor === "string" &&
        value.sourceAuthor.length <= 512)) &&
    isOptionalFiniteNumber(value.sourceCreatedAt) &&
    isOptionalFiniteNumber(value.sourceModifiedAt) &&
    (value.sourceInReplyToId === undefined ||
      isBoundedId(value.sourceInReplyToId)) &&
    (value.sourceReplyType === undefined ||
      value.sourceReplyType === "R" ||
      value.sourceReplyType === "Group")
  );
}

function hasValidAngle(value: Record<string, unknown>): boolean {
  return isOptionalFiniteNumber(value.angle);
}

function hasValidTextStyle(value: Record<string, unknown>): boolean {
  return (
    typeof value.text === "string" &&
    isFiniteNumber(value.fontSize) &&
    value.fontSize > 0 &&
    isHexColor(value.color) &&
    typeof value.bold === "boolean" &&
    (value.italic === undefined || typeof value.italic === "boolean") &&
    (value.align === "left" ||
      value.align === "center" ||
      value.align === "right") &&
    (value.fontFamily === "sans" ||
      value.fontFamily === "serif" ||
      value.fontFamily === "mono" ||
      value.fontFamily === "notoSansSc" ||
      value.fontFamily === "notoSansJp")
  );
}

function isOverlay(value: unknown): value is Overlay {
  if (!isRecord(value) || !hasValidOverlayCommon(value)) return false;
  if (
    value.type === "highlight" ||
    value.type === "underline" ||
    value.type === "strikethrough"
  ) {
    return (
      Array.isArray(value.rects) &&
      value.rects.every(isPdfRect) &&
      isHexColor(value.color) &&
      isFiniteNumber(value.opacity) &&
      value.opacity >= 0 &&
      value.opacity <= 1
    );
  }
  if (value.type === "ink") {
    return (
      Array.isArray(value.paths) &&
      value.paths.every(
        (path) => Array.isArray(path) && path.every(isPdfPoint),
      ) &&
      isHexColor(value.color) &&
      isFiniteNumber(value.width) &&
      value.width > 0 &&
      (value.source === undefined || value.source === "signature")
    );
  }
  if (value.type === "image") {
    return (
      isPdfRect(value.rect) &&
      (value.mimeType === "image/png" || value.mimeType === "image/jpeg") &&
      typeof value.dataUrl === "string" &&
      value.dataUrl.startsWith(`data:${value.mimeType};base64,`) &&
      (value.source === undefined || value.source === "signature") &&
      hasValidAngle(value)
    );
  }
  if (value.type === "stamp") {
    return (
      (value.kind === "check" || value.kind === "cross") &&
      isPdfRect(value.rect) &&
      isHexColor(value.color) &&
      isFiniteNumber(value.strokeWidth) &&
      value.strokeWidth > 0 &&
      hasValidAngle(value)
    );
  }
  if (value.type === "rect") {
    return (
      isPdfRect(value.rect) &&
      isHexColor(value.color) &&
      isFiniteNumber(value.strokeWidth) &&
      value.strokeWidth > 0 &&
      (value.fill === null || isHexColor(value.fill)) &&
      hasValidAngle(value)
    );
  }
  if (value.type === "note") {
    return (
      isPdfRect(value.rect) &&
      typeof value.text === "string" &&
      isHexColor(value.color) &&
      (value.createdAt === undefined ||
        isNonNegativeSafeInteger(value.createdAt)) &&
      (value.updatedAt === undefined ||
        isNonNegativeSafeInteger(value.updatedAt)) &&
      hasValidAngle(value)
    );
  }
  if (value.type === "text") {
    return isPdfRect(value.rect) && hasValidTextStyle(value) && hasValidAngle(value);
  }
  if (value.type === "callout") {
    return (
      isPdfRect(value.rect) &&
      Array.isArray(value.targetRects) &&
      value.targetRects.length > 0 &&
      value.targetRects.every(isPdfRect) &&
      (value.leader === undefined ||
        (Array.isArray(value.leader) &&
          (value.leader.length === 2 || value.leader.length === 3) &&
          value.leader.every(isPdfPoint))) &&
      (value.leaderKind === undefined ||
        value.leaderKind === "polyline" ||
        value.leaderKind === "quadratic") &&
      hasValidTextStyle(value)
    );
  }
  if (value.type === "contentText") {
    return (
      isPdfRect(value.rect) &&
      Array.isArray(value.coverRects) &&
      value.coverRects.every(isPdfRect) &&
      (value.sourceBaselinesPt === undefined ||
        (Array.isArray(value.sourceBaselinesPt) &&
          value.sourceBaselinesPt.every(isFiniteNumber))) &&
      isOptionalFiniteNumber(value.firstLineIndentPt) &&
      typeof value.originalText === "string" &&
      hasValidTextStyle(value) &&
      (value.renderedFont === undefined || typeof value.renderedFont === "string") &&
      (value.sourceFontName === undefined ||
        typeof value.sourceFontName === "string") &&
      isHexColor(value.backgroundColor) &&
      hasValidAngle(value)
    );
  }
  return false;
}

function hasUniqueIds(values: ReadonlyArray<{ id: string }>): boolean {
  const ids = new Set(values.map((value) => value.id));
  return ids.size === values.length;
}

function isDocumentModel(value: unknown): value is DocumentModel {
  if (!isRecord(value) || "kind" in value) return false;
  if (!Array.isArray(value.pages) || !value.pages.every(isPageModel)) return false;
  if (!hasUniqueIds(value.pages)) return false;
  if (!Array.isArray(value.overlays) || !value.overlays.every(isOverlay)) {
    return false;
  }
  if (!hasUniqueIds(value.overlays)) return false;
  const pageIds = new Set(value.pages.map((page) => page.id));
  return value.overlays.every((overlay) => pageIds.has(overlay.pageId));
}

const LIVE_BATCH_OVERLAY_TYPES = new Set([
  "highlight",
  "underline",
  "strikethrough",
  "ink",
  "stamp",
  "rect",
  "note",
  "callout",
  "text",
]);

function isOverlayBatchHistoryEntry(
  value: unknown,
): value is OverlayBatchHistoryEntry {
  if (!isRecord(value) || value.kind !== "overlay-batch") return false;
  if (!isSha256Hex(value.operationId)) {
    return false;
  }
  if (!Array.isArray(value.overlays) || value.overlays.length === 0) return false;
  if (!value.overlays.every(isOverlay) || !hasUniqueIds(value.overlays)) return false;
  if (
    !isSafeInteger(value.cursor) ||
    value.cursor <= 0 ||
    value.cursor > value.overlays.length
  ) {
    return false;
  }
  return value.overlays.every((overlay, index) => {
    if (!LIVE_BATCH_OVERLAY_TYPES.has(overlay.type)) return false;
    return overlay.id === `live-${overlay.type}-${value.operationId}-${index + 1}`;
  });
}

// Persisted history round-trips through IndexedDB and may come from older or
// corrupted records. Discriminate the tagged batch shape first: a malicious
// object must not masquerade as a DocumentModel merely by adding pages[].
export function sanitizeHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is HistoryEntry => {
    if (!isRecord(entry)) return false;
    return entry.kind === "overlay-batch"
      ? isOverlayBatchHistoryEntry(entry)
      : isDocumentModel(entry);
  });
}
