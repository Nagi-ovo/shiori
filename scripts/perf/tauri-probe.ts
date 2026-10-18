// Bundled by build-tauri-probe.ts into an isolated, disposable dev probe.
import { invoke } from "@tauri-apps/api/core";
import { sha256Hex } from "../../src/storage/hash";
import { workspaceDb } from "../../src/storage/workspace";
import { runtimeSessionStorageBytes } from "../../src/storage/runtimeSessions";
import { createFluidSimulation } from "../../src/brand/fluid/simulation";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const timings: Record<string, number[]> = {};
const values: Record<string, unknown> = {};

async function timed(name: string, work: () => Promise<unknown>) {
  const start = performance.now();
  const value = await work();
  (timings[name] ??= []).push(performance.now() - start);
  return value;
}

async function run() {
  await pause(2500);
  values.userAgent = navigator.userAgent;
  values.visibility = document.visibilityState;
  values.native = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  if (values.native) {
    for (let i = 0; i < 12; i++) {
      const metrics = timed("nativeMetricsMs", () => invoke("get_process_metrics"));
      await pause(10);
      await timed("nativePingDuringMetricsMs", () => invoke("runtime_guard_status"));
      values.lastMetrics = await metrics;
      await pause(300);
    }
  }
  for (const mib of [50, 200]) {
    const bytes = new Uint8Array(mib * 1024 * 1024).fill(0x5a);
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      const pending = sha256Hex(bytes);
      (timings[`hash${mib}MiBSyncMs`] ??= []).push(performance.now() - start);
      values[`hash${mib}`] = await timed(`hash${mib}MiBAwaitMs`, () => pending);
      (timings[`hash${mib}MiBTotalMs`] ??= []).push(performance.now() - start);
      await pause(100);
    }
  }
  // The bundler rewrites ONLY this module graph's DB name. The running app's
  // real workspace, sources, drafts and localStorage are never touched.
  if (!workspaceDb.name.startsWith("shiori-performance-probe-")) {
    throw new Error("Refusing to benchmark the user's workspace database");
  }
  try {
    await workspaceDb.open();
    for (let i = 0; i < 12; i++) {
      await workspaceDb.runtimePdfBlobs.put({
        hash: String(i).padStart(64, "0"),
        bytes: new Uint8Array(20 * 1024 * 1024).fill(i),
        size: 20 * 1024 * 1024,
        refCount: 1,
      });
    }
    let blobReads = 0;
    const onRead = (row: unknown) => { blobReads++; return row; };
    workspaceDb.runtimePdfBlobs.hook("reading", onRead);
    for (let i = 0; i < 7; i++) {
      values.runtimeBytes = await timed("runtimeStorage240MiBMs", runtimeSessionStorageBytes);
      await pause(100);
    }
    workspaceDb.runtimePdfBlobs.hook("reading").unsubscribe(onRead);
    values.blobRowsReadFor7Counts = blobReads;
  } finally {
    await workspaceDb.delete();
  }
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:-10000px;width:320px;height:200px";
  document.body.append(canvas);
  const gl = canvas.getContext("webgl2", {
    alpha: true, depth: false, stencil: false, antialias: false,
    preserveDrawingBuffer: false, premultipliedAlpha: false,
  });
  if (gl) {
    const live = new Map<string, Set<unknown>>();
    const api = gl as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const kind of ["Texture", "Framebuffer", "Shader", "Program", "Buffer"]) {
      const objects = new Set<unknown>();
      live.set(kind, objects);
      const create = api[`create${kind}`]!.bind(gl);
      const remove = api[`delete${kind}`]!.bind(gl);
      api[`create${kind}`] = (...args) => {
        const object = create(...args);
        if (object) objects.add(object);
        return object;
      };
      api[`delete${kind}`] = (object) => { objects.delete(object); return remove(object); };
    }
    const count = () => Object.fromEntries([...live].map(([kind, objects]) => [kind, objects.size]));
    const simulation = createFluidSimulation(canvas);
    values.fluidSupported = simulation.supported;
    for (let i = 0; i < 6; i++) {
      canvas.style.width = `${320 + i * 17}px`;
      simulation.resize();
    }
    values.fluidAfter6Resizes = count();
    values.fluidGlError = gl.getError();
    simulation.dispose();
    values.fluidAfterDispose = count();
    const remounted = createFluidSimulation(canvas);
    values.fluidRemountSupported = remounted.supported;
    remounted.dispose();
    values.fluidAfterRemountDispose = count();
    values.fluidContextLost = gl.isContextLost();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  canvas.remove();
  const summary = Object.fromEntries(Object.entries(timings).map(([key, raw]) => {
    const sorted = [...raw].sort((a, b) => a - b);
    return [key, {
      n: raw.length,
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      raw,
    }];
  }));
  await fetch("/__shiori_zoom_debug", {
    method: "POST",
    body: JSON.stringify({ type: "tauri-performance", at: new Date().toISOString(), values, summary }),
  });
}

void run().catch(async (error: unknown) => {
  await fetch("/__shiori_zoom_debug", {
    method: "POST",
    body: JSON.stringify({ type: "tauri-performance-error", error: String(error) }),
  });
});
