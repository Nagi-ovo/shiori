import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * codesign arguments for the packaged executable.
 *
 * An ad-hoc signature (`--sign -`) is the floor, not a choice: arm64 macOS
 * refuses to execute an unsigned Mach-O at all. It carries no identity, so a
 * user who acquires the archive through a browser — which stamps quarantine —
 * gets "Apple cannot check it for malicious software".
 *
 * With an identity we sign for real and turn on the hardened runtime, which
 * notarization requires. `--timestamp` matters because a signature without
 * one stops verifying the day the certificate expires, rather than staying
 * valid for what was signed while it was live.
 *
 * The hardened runtime refuses V8 the writable-and-executable memory its JIT
 * needs unless the executable carries `allow-jit` (`CLI_ENTITLEMENTS`), so
 * the Node executable is signed with it; without it 0.1.27 died at startup
 * on every Mac. The native/ libraries take no entitlements: only the main
 * executable's count.
 */
export function cliCodesignArgs(
  operatingSystem: NodeJS.Platform,
  identity: string | undefined,
  executable: string,
  entitlements?: string,
): string[] | null {
  if (operatingSystem !== "darwin") return null;
  const trimmed = identity?.trim();
  if (!trimmed) return ["--force", "--sign", "-", executable];
  return [
    "--force",
    "--sign",
    trimmed,
    "--options",
    "runtime",
    ...(entitlements ? ["--entitlements", entitlements] : []),
    "--timestamp",
    executable,
  ];
}

export const CLI_ENTITLEMENTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "entitlements.plist",
);
