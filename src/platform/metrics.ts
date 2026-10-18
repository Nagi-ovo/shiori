import { CAPABILITIES } from "./index";

export type ProcessMetrics = {
  cpuPercent: number | null;
  memoryBytes: number | null;
  platform: string;
};

export type BrowserMemoryMetrics = {
  jsHeapBytes: number | null;
  jsHeapLimitBytes: number | null;
};

export type GpuRendererInfo = {
  renderer: string | null;
  vendor: string | null;
};

export type StorageEstimateResult = {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
};

// WebGPU types aren't in the project's TS lib, so describe the slice we touch.
type GpuAdapterInfoLike = {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
};

type NavigatorWithGpu = Navigator & {
  gpu?: {
    requestAdapter?: () => Promise<{ info?: GpuAdapterInfoLike } | null>;
  };
};

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  };
};

export async function getProcessMetrics(): Promise<ProcessMetrics | null> {
  if (!CAPABILITIES.nativeProcessMetrics) return null;
  const { commands, unwrapCommand } = await import("./ipc");
  return unwrapCommand(await commands.getProcessMetrics());
}

export function readBrowserMemoryMetrics(): BrowserMemoryMetrics {
  if (typeof performance === "undefined") {
    return { jsHeapBytes: null, jsHeapLimitBytes: null };
  }
  const memory = (performance as PerformanceWithMemory).memory;
  return {
    jsHeapBytes: finiteOrNull(memory?.usedJSHeapSize),
    jsHeapLimitBytes: finiteOrNull(memory?.jsHeapSizeLimit),
  };
}

export function readGpuRendererInfo(): GpuRendererInfo {
  if (typeof document === "undefined") {
    return { renderer: null, vendor: null };
  }

  const canvas = document.createElement("canvas");
  const gl =
    canvas.getContext("webgl2") ?? canvas.getContext("webgl");

  if (!gl) return { renderer: null, vendor: null };

  try {
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    if (debugInfo) {
      return {
        renderer: stringifyGlValue(
          gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
        ),
        vendor: stringifyGlValue(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)),
      };
    }

    return {
      renderer: stringifyGlValue(gl.getParameter(gl.RENDERER)),
      vendor: stringifyGlValue(gl.getParameter(gl.VENDOR)),
    };
  } finally {
    // A settings-panel probe must not hold a GPU context until GC or exhaust
    // the WebView's context limit after repeated opens / StrictMode effects.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

// Real per-origin storage usage + device quota. Feature-detected; never throws.
// Returns nulls when the Storage API is unavailable (older iOS/Safari) so callers
// can fall back to the draft-sum / CAP_BYTES path.
export async function readStorageEstimate(): Promise<StorageEstimateResult> {
  const result: StorageEstimateResult = {
    usage: null,
    quota: null,
    persisted: null,
  };

  if (typeof navigator === "undefined" || !navigator.storage) {
    return result;
  }

  const storage = navigator.storage;

  try {
    if (typeof storage.estimate === "function") {
      const estimate = await storage.estimate();
      result.usage = finiteOrNull(estimate.usage);
      result.quota = finiteOrNull(estimate.quota);
    }
  } catch {
    // Leave usage/quota null — caller falls back to the draft sum / app cap.
  }

  try {
    if (typeof storage.persisted === "function") {
      result.persisted = await storage.persisted();
    }
  } catch {
    // Leave persisted null — eviction posture simply unknown.
  }

  return result;
}

// Richer GPU identity via WebGPU adapter info, falling back to the WebGL
// renderer-string probe. Async because requestAdapter() is async, so consumers
// must read it from an effect, not a useState initializer.
export async function readGpuAdapterInfo(): Promise<GpuRendererInfo> {
  if (typeof navigator !== "undefined") {
    const gpu = (navigator as NavigatorWithGpu).gpu;
    if (gpu?.requestAdapter) {
      try {
        const adapter = await gpu.requestAdapter();
        const info = adapter?.info;
        if (info) {
          const renderer = firstNonEmpty(
            info.description,
            info.architecture,
            info.device,
          );
          const vendor = firstNonEmpty(info.vendor);
          if (renderer || vendor) {
            return { renderer, vendor };
          }
        }
      } catch {
        // WebGPU probe failed — fall through to the WebGL renderer string.
      }
    }
  }

  return readGpuRendererInfo();
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringifyGlValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
