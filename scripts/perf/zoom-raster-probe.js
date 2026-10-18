// Zoom raster probe for docs/PERF-zoom-tiles.md. Paste into the devtools
// console of the dev build (`bun run dev`, http://localhost:1573/) with the
// PDF under test as the active tab, then run e.g.
// `await zoomRasterProbe([2, 4, 8], 3)`. Keep each call under ~40 s if you
// drive it through a CDP evaluate with a timeout.
//
// For each target scale: reset to 1×, clear the dev zoom collector, set the
// scale, and after 6 s read back the PageCanvas taps. `sharpMs` is the time
// from the scale change to the last raster (full page or tile) of that scale;
// `peakCanvasMB` samples every page canvas every 16 ms, backing stores only.
globalThis.zoomRasterProbe = async (targets, reps = 1) => {
  const ws = await import("/src/workspace/appWorkspace.ts");
  const reg = await import("/src/editor/store/tabStoreRegistry.ts");
  const store = reg.getTabEditorStore(ws.workspaceStore().getState().activeTabId);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const canvasBytes = () =>
    [...document.querySelectorAll("canvas.shioriPageCanvas, canvas.shioriPageTile")]
      .reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0);
  const results = [];
  for (let rep = 0; rep < reps; rep += 1) {
    for (const target of targets) {
      store.getState().setScale(1);
      await sleep(2900);
      await fetch("/__shiori_zoom_debug", { method: "DELETE" });
      let peak = 0;
      const sampler = setInterval(() => {
        peak = Math.max(peak, canvasBytes());
      }, 16);
      const t0 = performance.now();
      store.getState().setScale(target);
      await sleep(6000);
      clearInterval(sampler);
      await sleep(400);
      const events = (await (await fetch("/__shiori_zoom_debug")).text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const done = events.filter(
        (e) =>
          (e.kind === "rasterDone" || e.kind === "tileDone") &&
          Math.abs(e.scale - target) < 1e-6,
      );
      results.push({
        target,
        dpr: window.devicePixelRatio,
        sharpMs: done.length ? Math.round(done[done.length - 1].t - t0) : null,
        rasters: done.filter((e) => e.kind === "rasterDone").map((e) => `${e.w}x${e.h}`),
        tiles: done.filter((e) => e.kind === "tileDone").length,
        peakCanvasMB: +(peak / 2 ** 20).toFixed(1),
      });
    }
  }
  return results;
};
