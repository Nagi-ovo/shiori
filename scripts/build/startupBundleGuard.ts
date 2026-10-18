import type { Plugin } from "vite";

/**
 * Engines the app loads on demand. If a static import pulls one into the
 * entry chunk's closure, every launch pays to parse it before the first
 * paint. The check reads the built chunk graph, so it holds however the
 * import is written.
 */
const LAZY_ENGINES = ["src/pdf/export/exportPdf.ts", "src/pdf/merge/insertPdf.ts"];

type ChunkLike = {
  type: "chunk";
  fileName: string;
  isEntry: boolean;
  imports: string[];
  modules: Record<string, unknown>;
};

/** Lazy engines found in the static import closure of any entry chunk. */
export function lazyEnginesInEntryClosure(
  bundle: Record<string, { type: string }>,
  lazyEngines: readonly string[] = LAZY_ENGINES,
): string[] {
  const chunks = Object.values(bundle).filter(
    (item): item is ChunkLike => item.type === "chunk",
  );
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const reachable = new Set<string>();
  const visit = (fileName: string) => {
    if (reachable.has(fileName)) return;
    const chunk = byName.get(fileName);
    if (!chunk) return;
    reachable.add(fileName);
    chunk.imports.forEach(visit);
  };
  chunks.filter((chunk) => chunk.isEntry).forEach((chunk) => visit(chunk.fileName));
  const found = new Set<string>();
  for (const fileName of reachable) {
    for (const id of Object.keys(byName.get(fileName)!.modules)) {
      const engine = lazyEngines.find((path) => id.endsWith(path));
      if (engine) found.add(engine);
    }
  }
  return [...found];
}

/** Fails a production build that ships a lazy engine in the startup bundle. */
export function startupBundleGuard(): Plugin {
  return {
    name: "shiori-startup-bundle-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const leaked = lazyEnginesInEntryClosure(bundle);
      if (leaked.length > 0) {
        this.error(
          `Startup bundle statically includes ${leaked.join(", ")}; load it with import().`,
        );
      }
    },
  };
}
