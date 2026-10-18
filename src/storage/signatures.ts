import Dexie, { type Table } from "dexie";
import type {
  ImageOverlay,
  InkOverlay,
  PdfPoint,
  PdfRect,
} from "../pdf/model/types";

export type SavedInkSignature = {
  kind: "ink";
  id: string;
  name: string;
  paths: PdfPoint[][];
  color: string;
  lineWidthRatio: number;
  aspectRatio: number;
  createdAt: number;
  updatedAt: number;
};

export type SavedImageSignature = {
  kind: "image";
  id: string;
  name: string;
  dataUrl: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  aspectRatio: number;
  createdAt: number;
  updatedAt: number;
};

export type SavedSignature = SavedInkSignature | SavedImageSignature;

class SignaturesDb extends Dexie {
  signatures!: Table<SavedSignature, string>;

  constructor() {
    super("shiori-signatures");
    this.version(1).stores({
      signatures: "id, updatedAt",
    });
  }
}

const db = new SignaturesDb();
const changeListeners = new Set<() => void>();

export function subscribeSignatures(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function notifyChanged(): void {
  for (const listener of changeListeners) listener();
}

export async function listSignatures(): Promise<SavedSignature[]> {
  return db.signatures.orderBy("updatedAt").reverse().toArray();
}

export async function saveSignature(signature: SavedSignature): Promise<void> {
  await db.signatures.put(signature);
  notifyChanged();
}

export async function deleteSignature(id: string): Promise<void> {
  await db.signatures.delete(id);
  notifyChanged();
}

export function normalizeInkSignature({
  id,
  name,
  paths,
  width,
  height,
  color,
  lineWidth,
  now = Date.now(),
}: {
  id: string;
  name: string;
  paths: PdfPoint[][];
  width: number;
  height: number;
  color: string;
  lineWidth: number;
  now?: number;
}): SavedInkSignature {
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);
  const normalized = paths
    .map((path) =>
      path
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => ({
          x: clamp01(p.x / safeW),
          y: clamp01(p.y / safeH),
        })),
    )
    .filter((path) => path.length > 1);
  return {
    kind: "ink",
    id,
    name,
    paths: normalized,
    color,
    lineWidthRatio: Math.max(0.002, lineWidth / Math.min(safeW, safeH)),
    aspectRatio: safeW / safeH,
    createdAt: now,
    updatedAt: now,
  };
}

export function signatureToOverlay(
  signature: SavedSignature,
  rect: PdfRect,
  pageId: string,
  makeId: () => string,
): InkOverlay | ImageOverlay {
  const fitted = fitRectToAspect(rect, signature.aspectRatio);
  if (signature.kind === "image") {
    return {
      type: "image",
      id: makeId(),
      pageId,
      rect: fitted,
      dataUrl: signature.dataUrl,
      mimeType: signature.mimeType,
      source: "signature",
    } satisfies ImageOverlay;
  }
  return {
    type: "ink",
    id: makeId(),
    pageId,
    paths: signature.paths.map((path) =>
      path.map((p) => ({
        x: fitted.x + p.x * fitted.w,
        y: fitted.y + (1 - p.y) * fitted.h,
      })),
    ),
    color: signature.color,
    width: Math.max(0.75, signature.lineWidthRatio * Math.min(fitted.w, fitted.h)),
    source: "signature",
  } satisfies InkOverlay;
}

function fitRectToAspect(rect: PdfRect, aspectRatio: number): PdfRect {
  const safeAspect = Number.isFinite(aspectRatio) && aspectRatio > 0
    ? aspectRatio
    : 3;
  if (rect.w <= 0 || rect.h <= 0) return rect;
  const rectAspect = rect.w / rect.h;
  if (rectAspect > safeAspect) {
    const w = rect.h * safeAspect;
    return { x: rect.x + (rect.w - w) / 2, y: rect.y, w, h: rect.h };
  }
  const h = rect.w / safeAspect;
  return { x: rect.x, y: rect.y + (rect.h - h) / 2, w: rect.w, h };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
