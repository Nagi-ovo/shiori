import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { thirdPartyNotices } from "./thirdPartyNotices.ts";

// The minifier strips license comments, so whatever this plugin emits is the
// only copy of each bundled package's notice in the shipped web and desktop
// builds. MIT, ISC and Apache-2.0 all require that notice in redistributed
// copies. The plugin is driven through its Rollup hooks against a fake
// node_modules tree, standing in for a real `vite build`.

let root: string;

function write(path: string, body: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

const pkg = (name: string, version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, version, ...extra });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "shiori-notices-"));
  write("node_modules/react/package.json", pkg("react", "19.0.0", { license: "MIT" }));
  write("node_modules/react/LICENSE", "MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.\n");
  write("node_modules/react/cjs/react.production.js", "");
  write("node_modules/@noble/hashes/package.json", pkg("@noble/hashes", "1.8.0", { license: "MIT" }));
  write("node_modules/@noble/hashes/LICENSE.md", "Copyright (c) 2022 Paul Miller\n");
  write("node_modules/@noble/hashes/esm/sha2.js", "");
  write("node_modules/dexie/package.json", pkg("dexie", "4.0.0", { license: { type: "Apache-2.0" } }));
  write("node_modules/dexie/LICENSE", "Apache License\nVersion 2.0\n");
  write("node_modules/dexie/NOTICE", "Dexie.js NOTICE text\n");
  write("node_modules/dexie/dist/dexie.mjs", "");
  // A nested copy is its own package, with its own text.
  write("node_modules/outer/package.json", pkg("outer", "1.0.0", { license: "MIT" }));
  write("node_modules/outer/LICENSE", "Copyright outer authors\n");
  write("node_modules/outer/node_modules/inner/package.json", pkg("inner", "2.0.0", { licenses: [{ type: "BSD-3-Clause" }] }));
  write("node_modules/outer/node_modules/inner/LICENCE.txt", "Copyright inner authors\n");
  write("node_modules/outer/node_modules/inner/index.js", "");
  // Ships no license file: still listed, with what package.json declares.
  write("node_modules/bare/package.json", pkg("bare", "0.1.0", { license: "ISC" }));
  write("node_modules/bare/index.js", "");
  // @pdf-lib/fontkit 1.1.1 is bundled by the PDF export and its published
  // archive has no license file at all.
  write("node_modules/@pdf-lib/fontkit/package.json", pkg("@pdf-lib/fontkit", "1.1.1", { license: "MIT" }));
  write("node_modules/@pdf-lib/fontkit/dist/fontkit.es.js", "");
  write("node_modules/never-imported/package.json", pkg("never-imported", "1.0.0", { license: "MIT" }));
  write("node_modules/never-imported/LICENSE", "Copyright never-imported authors\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function run() {
  const plugin = thirdPartyNotices({ wasmCore: false });
  const emitted = new Map<string, string>();
  const ctx = {
    emitFile(file: { fileName: string; source: string | Uint8Array }) {
      emitted.set(file.fileName, typeof file.source === "string" ? file.source : Buffer.from(file.source).toString("utf8"));
      return file.fileName;
    },
  };
  const at = (path: string) => join(root, path);
  const bundle = {
    "assets/index.js": {
      type: "chunk",
      fileName: "assets/index.js",
      moduleIds: [
        "\0vite/preload-helper.js",
        at("src/main.tsx"),
        at("node_modules/react/cjs/react.production.js"),
        at("node_modules/react/index.js"),
        at("node_modules/@noble/hashes/esm/sha2.js"),
        `${at("node_modules/dexie/dist/dexie.mjs")}?v=1`,
        at("node_modules/@pdf-lib/fontkit/dist/fontkit.es.js"),
      ],
    },
    "assets/lazy.js": {
      type: "chunk",
      fileName: "assets/lazy.js",
      moduleIds: [at("node_modules/outer/node_modules/inner/index.js"), at("node_modules/bare/index.js").replaceAll("/", "\\")],
    },
    "assets/index.css": { type: "asset", fileName: "assets/index.css" },
  };
  const call = (hook: unknown, ...args: unknown[]) => {
    const fn = typeof hook === "function" ? hook : (hook as { handler?: unknown } | undefined)?.handler;
    if (typeof fn === "function") fn.call(ctx, ...args);
  };
  call(plugin.buildStart);
  call(plugin.generateBundle, {}, bundle, false);
  return [...emitted.values()].join("\n");
}

describe("thirdPartyNotices", () => {
  test("ships the license text of every npm package with code in the output", () => {
    const out = run();
    expect(out).toContain("Copyright (c) Meta Platforms, Inc. and affiliates.");
    expect(out).toContain("Copyright (c) 2022 Paul Miller");
    expect(out).toContain("Apache License\nVersion 2.0");
    expect(out).toContain("Dexie.js NOTICE text");
    expect(out).toContain("Copyright inner authors");
  });

  test("names each package once, with its version and declared license", () => {
    const out = run();
    expect(out.match(/^## react 19\.0\.0$/gm)).toHaveLength(1);
    expect(out).toContain("## @noble/hashes 1.8.0");
    expect(out).toMatch(/## dexie 4\.0\.0\n+License: Apache-2\.0/);
    expect(out).toMatch(/## inner 2\.0\.0\n+License: BSD-3-Clause/);
  });

  test("lists a package that ships no license file under what package.json declares", () => {
    expect(run()).toMatch(/## bare 0\.1\.0\n+License: ISC/);
  });

  // MIT and Apache-2.0 need the copyright and permission text, not an SPDX
  // id. fontkit also inlines Google's Brotli decoder, whose Apache notice the
  // minifier strips from the bundle.
  test("ships fontkit's copyright and permission text, and the notices of the code it inlines", () => {
    const fontkit = run().split(/^## /m).find((section) => section.startsWith("@pdf-lib/fontkit 1.1.1"));
    expect(fontkit).toContain("Copyright (c) 2014 Devon Govett");
    expect(fontkit).toContain("Permission is hereby granted, free of charge");
    expect(fontkit).toContain("Copyright 2013 Google Inc.");
    expect(fontkit).toContain("Apache License");
    expect(fontkit).toContain("Copyright (c) 2012 Niklas von Hertzen");
    expect(fontkit).not.toContain("ships no license file");
  });

  test("leaves out packages the output does not contain, and the app's own source", () => {
    const out = run();
    expect(out).not.toContain("never-imported");
    // `outer` only hosts the nested `inner`; none of its own code shipped.
    expect(out).not.toContain("## outer");
    expect(out).not.toContain("main.tsx");
  });

  test("writes the same file for the same input", () => {
    expect(run()).toBe(run());
  });
});
