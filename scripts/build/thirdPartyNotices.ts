import type { Plugin } from "vite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = new URL("../../", import.meta.url);

export function thirdPartyNotices({ wasmCore }: { wasmCore: boolean }): Plugin {
  return {
    name: "shiori-third-party-notices",
    apply: "build",
    buildStart() {
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_NOTICES.md",
        source: readFileSync(
          new URL("./THIRD_PARTY_NOTICES.md", REPO_ROOT),
          "utf8",
        ),
      });
      // The Word editor bundles harfbuzzjs, a prebuilt HarfBuzz wasm and
      // OFL/GUST fonts; each package carries the texts for what it ships.
      const docxEditor = fileURLToPath(new URL("./node_modules/@docx-editor.dev", REPO_ROOT));
      for (const pkg of ["core", "fonts", "react", "i18n"]) {
        const dir = join(docxEditor, pkg);
        const files = ["LICENSE", "THIRD_PARTY_NOTICES.md"].map((name) => join(dir, name));
        if (existsSync(join(dir, "licenses"))) files.push(...listFiles(join(dir, "licenses")));
        for (const file of files) {
          this.emitFile({
            type: "asset",
            fileName: `licenses/docx-editor/${pkg}/${relative(dir, file).replaceAll("\\", "/")}`,
            source: readFileSync(file),
          });
        }
      }
      // The wasm core ships PDFium and Rust crates; their texts come from
      // scripts/pdfium/build-wasm.ts.
      if (wasmCore) {
        const licenses = fileURLToPath(new URL("./src/pdf/engine/wasm/generated/licenses", REPO_ROOT));
        for (const file of listFiles(licenses)) {
          this.emitFile({
            type: "asset",
            fileName: `licenses/${relative(licenses, file).replaceAll("\\", "/")}`,
            source: readFileSync(file),
          });
        }
      }
    },
  };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
