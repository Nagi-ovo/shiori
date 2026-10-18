import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  directoryUrl,
  resolveCliRuntimeAssets,
} from "../src/runtimeAssets";

describe("Shiori CLI runtime assets", () => {
  test("resolves every required source-checkout asset", () => {
    const assets = resolveCliRuntimeAssets();
    expect(assets.cmaps).toContain("pdfjs-dist");
    expect(assets.standardFonts).toContain("standard_fonts");
    expect(assets.wasm).toContain("wasm");
    expect(assets.iccs).toContain("iccs");
    expect(assets.notoSansSc).toEndWith("NotoSansSC-Regular.otf");
    expect(assets.notoSansJp).toEndWith("NotoSansJP-Regular.otf");
    expect(directoryUrl(assets.cmaps)).toEndWith("/");
  });

  test("honors a complete packaged asset override", async () => {
    const root = await mkdtemp(join(tmpdir(), "shiori-cli-assets-"));
    const previous = process.env.SHIORI_CLI_ASSET_DIR;
    try {
      const files = [
        ["pdfjs", "cmaps", "Adobe-GB1-UCS2.bcmap"],
        ["pdfjs", "standard_fonts", "LiberationSans-Regular.ttf"],
        ["pdfjs", "wasm", "openjpeg.wasm"],
        ["pdfjs", "iccs", "CGATS001Compat-v2-micro.icc"],
        ["fonts", "NotoSansSC-Regular.otf"],
        ["fonts", "NotoSansJP-Regular.otf"],
      ];
      for (const parts of files) {
        const path = join(root, ...parts);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "fixture");
      }
      process.env.SHIORI_CLI_ASSET_DIR = root;
      expect(resolveCliRuntimeAssets().root).toBe(root);
    } finally {
      if (previous == null) delete process.env.SHIORI_CLI_ASSET_DIR;
      else process.env.SHIORI_CLI_ASSET_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
