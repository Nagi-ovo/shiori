import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const siteRoot = dirname(fileURLToPath(import.meta.url));

// In production /cli is a Pages Function and /cli.ps1 is a static asset with
// a _headers rule. Dev has neither, and Vite would serve the extensionless
// /cli as the SPA index — the same shape as the routing bug that made
// `curl | sh` receive HTML with a 200. Serve both here so the install
// one-liners can be exercised against `bun run dev`.
const HOSTED_INSTALLERS: Readonly<Record<string, string>> = {
  "/cli": "cli.sh",
  "/cli.ps1": "cli.ps1",
};

function cliInstaller(): Plugin {
  return {
    name: "shiori-cli-installer",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const asset = HOSTED_INSTALLERS[req.url?.split("?")[0] ?? ""];
        if (!asset) {
          next();
          return;
        }
        const body = await readFile(resolve(siteRoot, "public", asset), "utf8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(body);
      });
    },
  };
}

// Standalone Vite project for the public homepage. Lives entirely under
// site/ — separate node_modules, separate dist, separate dev port. The
// main Tauri-bundled app at the repo root is unaware of this project,
// and vice versa: nothing here is ever included in the desktop binary.
export default defineConfig({
  plugins: [react(), cliInstaller()],
  server: {
    // 1573 is the main app's dev port; the homepage gets 5174 so both
    // can run side-by-side.
    port: 5174,
    strictPort: true,
  },
  preview: {
    port: 5174,
    strictPort: true,
  },
});
