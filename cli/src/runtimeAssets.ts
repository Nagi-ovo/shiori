import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CliRuntimeAssets = {
  root: string;
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

function packagedAssets(root: string): CliRuntimeAssets {
  return {
    root,
    notoSansSc: join(root, "fonts", "NotoSansSC-Regular.otf"),
    notoSansJp: join(root, "fonts", "NotoSansJP-Regular.otf"),
  };
}

function sourceAssets(root: string): CliRuntimeAssets {
  return {
    root,
    notoSansSc: join(root, "src", "assets", "fonts", "NotoSansSC-Regular.otf"),
    notoSansJp: join(root, "src", "assets", "fonts", "NotoSansJP-Regular.otf"),
  };
}

function assetsExist(assets: CliRuntimeAssets): boolean {
  return existsSync(assets.notoSansSc) && existsSync(assets.notoSansJp);
}
