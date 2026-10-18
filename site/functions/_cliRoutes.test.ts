import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const publicDir = resolve(import.meta.dir, "..", "public");

const routes = JSON.parse(
  readFileSync(resolve(publicDir, "_routes.json"), "utf8"),
) as { include?: string[] };

const headers = readFileSync(resolve(publicDir, "_headers"), "utf8");

describe("Pages Functions routing", () => {
  test("sends /cli through the installer function instead of the SPA fallback", () => {
    expect(routes.include).toEqual(
      expect.arrayContaining(["/download/*", "/api/*", "/cli"]),
    );
  });

  test("leaves /cli.ps1 as a static asset", () => {
    // It has no function; listing it here would route it to the SPA fallback
    // and `irm | iex` would run index.html.
    expect(routes.include).not.toContain("/cli.ps1");
  });
});

describe("Pages static headers", () => {
  test("serves /cli.ps1 as text so PowerShell hands iex a string", () => {
    const block = headers.split(/^\/cli\.ps1$/m)[1];
    expect(block).toBeDefined();
    expect(block).toContain("Content-Type: text/plain; charset=utf-8");
  });
});

describe("Pages Functions layout", () => {
  test("keeps test files out of the route namespace", () => {
    // Cloudflare Pages compiles EVERY .ts under functions/ into the Worker
    // and treats it as a route, except files whose name starts with "_".
    // A test file left un-prefixed becomes a route that imports bun:test and
    // node:fs, neither of which exists in the Workers runtime — so the deploy
    // fails while every local gate stays green, because `bun run build` only
    // runs vite and never touches functions/.
    const offenders: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(resolve(dir, entry.name), `${prefix}${entry.name}/`);
          continue;
        }
        if (entry.name.endsWith(".test.ts") && !entry.name.startsWith("_")) {
          offenders.push(prefix + entry.name);
        }
      }
    };
    walk(resolve(import.meta.dir), "");
    expect(offenders).toEqual([]);
  });
});
