import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CliRuntimeAssets = {
  root: string;
  cmaps: string;
  standardFonts: string;
  wasm: string;
  iccs: string;
  notoSansSc: string;
  notoSansJp: string;
};

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function resolveCliRuntimeAssets(): CliRuntimeAssets {
  const override = process.env.SHIORI_CLI_ASSET_DIR?.trim();
  const packagedCandidates = [
    ...(override ? [resolve(override)] : []),
    join(dirname(process.execPath), "assets"),
  ];
  for (const root of packagedCandidates) {
    const candidate = packagedAssets(root);
    if (assetsExist(candidate)) return candidate;
  }

  const source = sourceAssets(SOURCE_ROOT);
  if (assetsExist(source)) return source;
  throw new Error(
    "Shiori CLI runtime assets are missing. Reinstall the complete distribution or set SHIORI_CLI_ASSET_DIR.",
  );
}

export function directoryUrl(path: string): string {
  return `${path.endsWith("/") ? path : `${path}/`}`;
}

function packagedAssets(root: string): CliRuntimeAssets {
  return {
    root,
    cmaps: join(root, "pdfjs", "cmaps"),
    standardFonts: join(root, "pdfjs", "standard_fonts"),
    wasm: join(root, "pdfjs", "wasm"),
    iccs: join(root, "pdfjs", "iccs"),
    notoSansSc: join(root, "fonts", "NotoSansSC-Regular.otf"),
    notoSansJp: join(root, "fonts", "NotoSansJP-Regular.otf"),
  };
}

function sourceAssets(root: string): CliRuntimeAssets {
  return {
    root,
    cmaps: join(root, "node_modules", "pdfjs-dist", "cmaps"),
    standardFonts: join(root, "node_modules", "pdfjs-dist", "standard_fonts"),
    wasm: join(root, "node_modules", "pdfjs-dist", "wasm"),
    iccs: join(root, "node_modules", "pdfjs-dist", "iccs"),
    notoSansSc: join(root, "src", "assets", "fonts", "NotoSansSC-Regular.otf"),
    notoSansJp: join(root, "src", "assets", "fonts", "NotoSansJP-Regular.otf"),
  };
}

function assetsExist(assets: CliRuntimeAssets): boolean {
  return (
    existsSync(join(assets.cmaps, "Adobe-GB1-UCS2.bcmap")) &&
    existsSync(join(assets.standardFonts, "LiberationSans-Regular.ttf")) &&
    existsSync(join(assets.wasm, "openjpeg.wasm")) &&
    existsSync(join(assets.iccs, "CGATS001Compat-v2-micro.icc")) &&
    existsSync(assets.notoSansSc) &&
    existsSync(assets.notoSansJp)
  );
}
