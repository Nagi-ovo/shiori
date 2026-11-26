import { snapshotKeyFromBytes, snapshotKeyFromJson } from "../../shared/snapshotKey";
import type { DocumentModel } from "../model/types";
import { reflowEnabled } from "./contentText/reflowTypes";
import type { ExportOptions } from "./exportPdf";
import { stage5Type1 } from "./fontCoverage/type1Support";

const serviceIds = new WeakMap<object, number>();
let nextServiceId = 0;

function serviceId(service: object): number {
  const existing = serviceIds.get(service);
  if (existing !== undefined) return existing;
  const id = ++nextServiceId;
  serviceIds.set(service, id);
  return id;
}

type KeyPart = string | number | boolean | null | KeyPart[];

function keyPart(value: unknown): KeyPart {
  if (value === undefined) return ["undefined"];
  if (typeof value === "function") return ["service", serviceId(value)];
  if (typeof value === "number" && !Number.isFinite(value)) return ["number", String(value)];
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const type = value instanceof Uint8Array ? "Uint8Array" : value.constructor.name;
    return ["binary", type, snapshotKeyFromBytes(bytes)];
  }
  if (value instanceof Map) {
    const entries = Array.from(value, ([key, entry]) => JSON.stringify([keyPart(key), keyPart(entry)]));
    return ["map", entries.sort()];
  }
  if (value instanceof Set) return ["set", Array.from(value, entry => JSON.stringify(keyPart(entry))).sort()];
  if (Array.isArray(value)) return ["array", Array.from(value, keyPart)];
  if (typeof value === "object") {
    return ["object", Object.keys(value).sort().flatMap(key => {
      const entry = (value as Record<string, unknown>)[key];
      return entry === undefined ? [] : [[key, keyPart(entry)]];
    })];
  }
  throw new TypeError(`Unsupported export key value: ${typeof value}`);
}

/** Identity of an export request. A compact raster also depends on its open
 * document handle, which is opaque and scoped to this process. */
export function exportCandidateKey(
  originalBytes: Uint8Array,
  model: DocumentModel,
  options: ExportOptions = {},
  rasterDocument?: object,
): string {
  return exportCandidateKeyFromSourceKey(snapshotKeyFromBytes(originalBytes), model, options, rasterDocument);
}

/** The editor can reuse the source digest while its opened bytes are immutable. */
export function exportCandidateKeyFromSourceKey(
  sourceKey: string,
  model: DocumentModel,
  options: ExportOptions = {},
  rasterDocument?: object,
): string {
  const { sourceEncryption } = options;
  const effective = {
    ...options,
    unicodeFontErrorMessage: undefined,
    acceptance: options.acceptance ?? "review",
    mode: options.mode ?? "annotations",
    quality: options.quality ?? "original",
    documentFiles: options.documentFiles ?? "auto",
    preserveSourceAnnotations: options.preserveSourceAnnotations ?? false,
    requireUnicodeFont: options.requireUnicodeFont ?? false,
    stage5Substitute: options.stage5Substitute ?? true,
    stage5Type1: {
      sourceReuse: options.stage5Type1?.sourceReuse ?? stage5Type1.sourceReuse,
      standard14Afm: options.stage5Type1?.standard14Afm ?? stage5Type1.standard14Afm,
    },
    stage5Reflow: reflowEnabled(options.stage5Reflow),
    reflowRequests: options.reflowRequests?.size ? new Map(options.reflowRequests) : undefined,
    inPlaceFallback: {
      loadFont: options.inPlaceFallback?.loadFont,
      localFonts: options.inPlaceFallback?.localFonts?.length ? options.inPlaceFallback.localFonts : undefined,
    },
    sourceEncryption: sourceEncryption && {
      handler: serviceId(sourceEncryption),
      security: sourceEncryption.security,
      plaintext: sourceEncryption.plaintext,
      encrypt: sourceEncryption.encrypt,
    },
  };
  // The editor updates this timestamp on each keystroke, independently of paint.
  const snapshot = { ...model, overlays: model.overlays.map(overlay => ({ ...overlay, localActivityAt: undefined })) };
  return snapshotKeyFromJson(JSON.stringify([
    "pdf-export", sourceKey, keyPart(snapshot), keyPart(effective),
    rasterDocument ? ["raster", serviceId(rasterDocument)] : ["vector"],
  ]));
}
