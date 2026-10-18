/** Inspect the production entry's complete static JS dependency closure.
 * Run: bun scripts/perf/inspect-entry.ts [output.json]
 * This builds dist; gzip is a web transfer reference, not a Tauri start time.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "vite";

const output = resolve(
  process.argv[2] ?? "node_modules/.cache/shiori-performance/entry-audit.json",
);

await build({
  plugins: [{
    name: "shiori-inspect-entry",
    async writeBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
      const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
      const entries = chunks.filter((chunk) => chunk.isEntry).map((entry) => {
        const reachable = new Set<string>();
        const visit = (file: string) => {
          if (reachable.has(file)) return;
          const chunk = byName.get(file);
          if (!chunk) return;
          reachable.add(file);
          chunk.imports.forEach(visit);
        };
        visit(entry.fileName);
        const files = [...reachable].map((file) => {
          const chunk = byName.get(file)!;
          return {
            file,
            bytes: Buffer.byteLength(chunk.code),
            gzipBytes: gzipSync(chunk.code).byteLength,
            modules: Object.keys(chunk.modules).map((id) =>
              id.replace(`${process.cwd()}/`, ""),
            ),
          };
        });
        return {
          entry: entry.fileName,
          staticJsBytes: files.reduce((sum, file) => sum + file.bytes, 0),
          staticJsGzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
          files,
        };
      });
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify({
        notes: "UTF-8 JS bytes, static imports only; excludes CSS, fonts, workers and dynamic imports. Gzip is not native launch timing.",
        entries,
      }, null, 2)}\n`);
      console.log(`Entry dependency report: ${output}`);
    },
  }],
});
