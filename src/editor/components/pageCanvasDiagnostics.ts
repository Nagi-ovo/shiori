// What PageCanvas records when a page fails to render or renders blank
// (DiagOverlay.tsx shows it in dev builds).

type DiagPhase = "render-rejected" | "render-succeeded-but-blank";

export type DiagPayload = {
  when: string;
  phase: DiagPhase;
  err: { name?: string; message?: string; stack?: string } | null;
  ua: string;
  /** The engine that drew the page (PdfEngine.label). */
  engine: string;
  appVersion: string;
  pageIndex: number;
  canvas: { w: number; h: number };
  viewport: { w: number; h: number };
  dpr: number;
  caps: {
    offscreenCanvas: boolean;
    imageDecoder: boolean;
    path2d: boolean;
    webgl: boolean;
  };
  loc: string;
  samplePixels?: string[];
  // Two-stage blank detector telemetry: how many pixels stage 2 actually
  // scanned and how many were non-white. We only emit the diagnostic
  // when both stages are all white, but recording the numbers lets us
  // distinguish "near-certainly blank" from a borderline 7×7 false
  // positive in postmortem analysis.
  checkedPixels?: number;
  nonWhiteSamples?: number;
};

const LS_KEY = "shioriRenderDiagnostics";
const LS_ENABLED_KEY = "shioriRenderDiagnosticsEnabled";

export function buildCaps(): DiagPayload["caps"] {
  const g = globalThis as { ImageDecoder?: unknown };
  let webgl = false;
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") || probe.getContext("webgl");
    webgl = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webgl = false;
  }
  return {
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    imageDecoder: typeof g.ImageDecoder !== "undefined",
    path2d: typeof Path2D !== "undefined",
    webgl,
  };
}

export function appendLocalStorage(payload: DiagPayload): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? (JSON.parse(raw) as DiagPayload[]) : [];
    arr.push(payload);
    while (arr.length > 20) arr.shift();
    localStorage.setItem(LS_KEY, JSON.stringify(arr));
  } catch {
    // localStorage full or parse error — drop silently.
  }
}

export function renderDiagnosticsEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return localStorage.getItem(LS_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}
