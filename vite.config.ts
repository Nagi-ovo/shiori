import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { startupBundleGuard } from "./scripts/build/startupBundleGuard.ts";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Tauri-aware Vite config. The same build output serves the web deploy
// (Vercel / any static host) and is embedded inside the desktop app; the
// only settings below that Tauri cares about are clearScreen, the fixed
// dev port, and the HMR host override when cross-platform.
//
// TAURI_DEV_HOST is injected by `tauri dev` on Linux/Android when the
// webview can't reach `localhost`; everywhere else it stays undefined and
// Vite picks its usual defaults.
const host = process.env.TAURI_DEV_HOST;

// Optional build-time expiry for closed beta builds. Public desktop and
// mobile releases must not self-destruct, so expiry is off unless the
// release command explicitly opts in with SHIORI_ENABLE_BUILD_EXPIRY=true.
const ENABLE_BUILD_EXPIRY = process.env.SHIORI_ENABLE_BUILD_EXPIRY === "true";
const EXPIRY_DAYS = Number.parseInt(
  process.env.SHIORI_BUILD_EXPIRY_DAYS ?? "60",
  10,
);
const ANDROID_DISTRIBUTION = normalizeAndroidDistribution(
  process.env.SHIORI_ANDROID_DISTRIBUTION,
);
const appVersion = readAppVersion();

function readAppVersion(): string {
  try {
    const raw = readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (parsed.version) return parsed.version;
  } catch {
    // fall back below
  }
  try {
    const raw = readFileSync(new URL("./package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function normalizeAndroidDistribution(value: string | undefined): string {
  if (value === "google-play" || value === "direct-apk") return value;
  return "";
}

// The desktop build draws with the native core, so the wasm one, its worker
// and 5.6 MB of wasm stay out of it. Vite emits a worker as soon as it sees
// `new Worker(new URL(...))`, before tree-shaking could drop it, so the web
// engine's module is replaced whole.
const WASM_CORE = !["macos", "windows", "linux"].includes(process.env.TAURI_ENV_PLATFORM ?? "");

function desktopWithoutWasmCore(): Plugin {
  return {
    name: "shiori-desktop-without-wasm-core",
    enforce: "pre",
    load(id) {
      if (!WASM_CORE && id.replaceAll("\\", "/").endsWith("/src/pdf/engine/pdfiumWebEngine.ts")) {
        return "export const pdfiumWebEngine = undefined;";
      }
    },
  };
}


function thirdPartyNotices(): Plugin {
  return {
    name: "shiori-third-party-notices",
    apply: "build",
    buildStart() {
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_NOTICES.md",
        source: readFileSync(
          new URL("./THIRD_PARTY_NOTICES.md", import.meta.url),
          "utf8",
        ),
      });
      // The Word editor bundles harfbuzzjs, a prebuilt HarfBuzz wasm and
      // OFL/GUST fonts; each package carries the texts for what it ships.
      const docxEditor = fileURLToPath(new URL("./node_modules/@docx-editor.dev", import.meta.url));
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
      if (WASM_CORE) {
        const licenses = fileURLToPath(new URL("./src/pdf/engine/wasm/generated/licenses", import.meta.url));
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


function zoomDebugCollector(): Plugin {
  // Dev-only zoom diagnostics. The Canvas taps publish NDJSON event lines
  // here; reading them back is a plain GET (curl) — no file ever touches the
  // repo, and release builds compile the taps out entirely.
  let lines: string[] = [];
  return {
    name: "shiori-zoom-debug-collector",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
        if (pathname !== "/__shiori_zoom_debug") {
          next();
          return;
        }
        if (req.method === "GET") {
          res.statusCode = 200;
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
          res.end(lines.join("\n"));
          return;
        }
        if (req.method === "DELETE") {
          lines = [];
          res.statusCode = 202;
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          if (body.length <= 256_000) body += chunk;
        });
        req.on("end", () => {
          if (body) lines.push(...body.split("\n").filter(Boolean));
          if (lines.length > 6_000) lines.splice(0, lines.length - 6_000);
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

function tabPerfMetrics(): Plugin {

  let latest = "null";
  let resetAfter = 0;
  return {
    name: "shiori-tab-perf-metrics",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
        if (pathname !== "/__shiori_tab_perf") {
          next();
          return;
        }
        if (req.method === "GET") {
          res.statusCode = 200;
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(latest);
          return;
        }
        if (req.method === "DELETE") {
          // The Tauri WebView does not expose a browser reload shortcut. Ask
          // the next client publication to reset its in-page counters instead;
          // this preserves all open PDFs and makes before/after runs repeatable.
          resetAfter = Date.now();
          res.statusCode = 202;
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          if (body.length <= 64_000) body += chunk;
        });
        req.on("end", () => {
          if (body.length > 64_000) {
            res.statusCode = 413;
          } else {
            let startedAt = 0;
            try {
              const parsed = JSON.parse(body) as { startedAt?: unknown };
              if (typeof parsed.startedAt === "number") {
                startedAt = parsed.startedAt;
              }
            } catch {
              // The client owns this dev-only schema. Treat malformed input
              // as stale while a reset is pending, otherwise keep it visible.
            }
            if (resetAfter > 0 && startedAt < resetAfter) {
              // Do not let an already in-flight old publication overwrite the
              // freshly reset baseline. Every stale response receives the
              // reset signal until a new-generation summary arrives.
              res.statusCode = 205;
            } else {
              latest = body || "null";
              if (resetAfter > 0) resetAfter = 0;
              res.statusCode = 204;
            }
          }
          res.end();
        });
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), desktopWithoutWasmCore(), tabPerfMetrics(), zoomDebugCollector(), thirdPartyNotices(), startupBundleGuard()],
  clearScreen: false,
  server: {
    port: 1573,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5174,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    chunkSizeWarningLimit: 2500,
    // Target recent engines only — Tauri's webview on desktop is modern,
    // and we require ES2020+ features anyway.
    target: "es2022",
    // Keep source maps OFF in production. Flip to "hidden" only if you
    // wire an error tracker (Sentry et al.) that can consume them
    // privately — never set to true for public deploys.
    sourcemap: false,
  },
  // Neutralise console.* in production bundles so nothing useful gets
  // emitted even if someone opens a webview console. Vite's `define`
  // does token-level substitution at parse time — each call becomes a
  // no-op arrow that ignores its args. Dev builds leave these alone.
  define: {
    ...(command === "build"
      ? {
          "console.log": "(()=>{})",
          "console.info": "(()=>{})",
          "console.debug": "(()=>{})",
          "console.warn": "(()=>{})",
          "console.error": "(()=>{})",
        }
      : {}),
    __BUILD_TIMESTAMP__: JSON.stringify(
      command === "build" && ENABLE_BUILD_EXPIRY ? Date.now() : 0,
    ),
    __BUILD_EXPIRY_DAYS__: JSON.stringify(
      ENABLE_BUILD_EXPIRY && Number.isFinite(EXPIRY_DAYS)
        ? EXPIRY_DAYS
        : 0,
    ),
    __APP_VERSION__: JSON.stringify(appVersion),
    __TAURI_ENV_PLATFORM__: JSON.stringify(process.env.TAURI_ENV_PLATFORM ?? ""),
    __TAURI_ENV_FAMILY__: JSON.stringify(process.env.TAURI_ENV_FAMILY ?? ""),
    __TAURI_ENV_TARGET_TRIPLE__: JSON.stringify(
      process.env.TAURI_ENV_TARGET_TRIPLE ?? "",
    ),
    __SHIORI_ANDROID_DISTRIBUTION__: JSON.stringify(ANDROID_DISTRIBUTION),
    // The wasm core (src/pdf/engine/wasm) serves the web and mobile builds.
    __SHIORI_WASM_CORE__: JSON.stringify(WASM_CORE),
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // The DOCX font package resolves its TTFs with a dynamic `new URL()`.
    // Pre-bundling erases Vite's asset map and turns those requests into
    // `/node_modules/.vite/deps/undefined`; direct transformation preserves it.
    exclude: ["@docx-editor.dev/fonts"],
  },
}));
