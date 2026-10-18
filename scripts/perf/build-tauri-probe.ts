import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Run against an existing tauri dev session. Load the generated module from
// /node_modules/.cache/shiori-performance/__shiori_performance_probe.js with a
// temporary dev-only script tag. Capture /__shiori_zoom_debug, then remove the
// loader before committing. Keeping output outside public/ prevents accidental
// inclusion of this allocating benchmark in a production bundle.
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "tauri-probe.ts")],
  outdir: resolve(import.meta.dir, "../../node_modules/.cache/shiori-performance"),
  naming: "__shiori_performance_probe.js",
  target: "browser",
  format: "esm",
  define: { "import.meta.env.DEV": "true", "import.meta.env.PROD": "false" },
  plugins: [{
    name: "isolated-workspace-db",
    setup(build) {
      build.onLoad({ filter: /[/\\]storage[/\\]workspace\.ts$/ }, async ({ path }) => ({
        contents: (await readFile(path, "utf8")).replace(
          'super("shiori-workspace")',
          'super("shiori-performance-probe-2026-09-07")',
        ),
        loader: "ts",
      }));
    },
  }],
});
if (!result.success) throw new Error(result.logs.join("\n"));
