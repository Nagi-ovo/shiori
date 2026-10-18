import { CAPABILITIES } from "./index";

export type SaveOptions = {
  suggestedName: string;
  mime?: string;
};

export type SaveResult =
  | { status: "saved"; path: string; platform: "desktop" | "web" | "mobile" }
  | { status: "cancelled" };

// The suggested filename crosses Tauri IPC as a fetch header, and WebKit's
// Headers constructor rejects non-ISO-8859-1 values — a CJK filename threw
// TypeError before the request was even sent, failing the whole export.
// Base64-encode the UTF-8 name so the header value is always ASCII; the
// Rust side decodes it.
export function encodeSuggestedNameHeader(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

// Persist bytes to a location the user picks. On desktop, delegates dialog +
// filesystem writes to narrow Rust commands. On web, falls back to a plain
// Blob download — good enough for static hosting with zero server support.
export async function saveBytes(
  bytes: Uint8Array,
  options: SaveOptions,
): Promise<SaveResult> {
  if (CAPABILITIES.nativePaths) {
    return await saveBytesTauri(bytes, options);
  }
  if (CAPABILITIES.mobileShareExport) {
    return await saveBytesMobile(bytes, options);
  }
  return saveBytesWeb(bytes, options);
}

async function saveBytesTauri(
  bytes: Uint8Array,
  options: SaveOptions,
): Promise<SaveResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  const path = await invoke<string | null>(
    "save_pdf_dialog",
    new Uint8Array(bytes),
    {
      headers: {
        "x-shiori-suggested-name": encodeSuggestedNameHeader(
          options.suggestedName,
        ),
      },
    },
  );
  return path
    ? { status: "saved", path, platform: "desktop" }
    : { status: "cancelled" };
}

async function saveBytesMobile(
  bytes: Uint8Array,
  options: SaveOptions,
): Promise<SaveResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  const path = await invoke<string | null>(
    "save_pdf_dialog",
    new Uint8Array(bytes),
    {
      headers: {
        "x-shiori-suggested-name": encodeSuggestedNameHeader(
          options.suggestedName,
        ),
      },
    },
  );
  if (!path) return { status: "cancelled" };

  const androidBridge =
    typeof window === "undefined" ? undefined : window.ShioriAndroid;
  if (androidBridge?.shareExport) {
    const raw = androidBridge.shareExport(
      JSON.stringify({
        path,
        filename: options.suggestedName,
        mime: options.mime ?? "application/octet-stream",
        title: options.suggestedName,
      }),
    );
    const parsed = parseAndroidBridgeResult(raw);
    if (!parsed.ok) {
      throw new Error(parsed.message || "android-share-export-failed");
    }
    // Newer shells report the user's actual share-target pick; only a pick
    // marks the export saved, mirroring iOS's completion semantics — the
    // chooser being dismissed used to clear the "needs export" flag as if
    // the share happened. Older shells (no marker) keep legacy behavior.
    if (parsed.awaitChoice) {
      const chosen = await waitForAndroidShareChoice();
      if (!chosen) return { status: "cancelled" };
    }
    return { status: "saved", path: options.suggestedName, platform: "mobile" };
  }

  // iOS (and any Tauri-mobile target without the Android bridge): present the
  // native share sheet via the shiori-browser plugin command. We deliberately
  // do NOT fall back to the opener plugin here: `openPath` on iOS calls
  // UIApplication.open with a scheme-less cache path, which silently no-ops yet
  // resolves — so the export looked "shared" while the file was stranded in an
  // OS-reclaimable cache dir. A failed share now surfaces an honest error.
  let completed = false;
  try {
    const { commands, unwrapCommand } = await import("./ipc");
    completed = unwrapCommand(
      await commands.shareExportedFile(
        path,
        options.suggestedName,
        options.mime ?? "application/octet-stream",
      ),
    );
  } catch (err) {
    throw new Error(
      `mobile-share-export-failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // Only report "saved" when the user actually completed a share activity; a
  // dismissed sheet means nothing reached the user, so don't let the caller
  // mark the document exported.
  return completed
    ? { status: "saved", path: options.suggestedName, platform: "mobile" }
    : { status: "cancelled" };
}

export function parseAndroidBridgeResult(raw: string): {
  ok?: boolean;
  message?: string;
  awaitChoice?: boolean;
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, message: "android-share-export-invalid-response" };
    }
    const value = parsed as {
      ok?: unknown;
      message?: unknown;
      awaitChoice?: unknown;
    };
    return {
      ok: value.ok === true,
      message: typeof value.message === "string" ? value.message : undefined,
      awaitChoice: value.awaitChoice === true,
    };
  } catch {
    return { ok: false, message: "android-share-export-invalid-response" };
  }
}

const ANDROID_SHARE_CHOSEN_EVENT = "shiori-android-share-chosen";
// Grace after the app returns to the foreground: the chosen broadcast and
// the activity resume race each other, so the event gets a moment to land
// before the share counts as cancelled.
const SHARE_RESUME_GRACE_MS = 1500;
// Backstop for devices that never deliver visibility events while the
// chooser is up — conservative: expiring counts as cancelled, which only
// keeps the "needs export" marker.
const SHARE_CHOICE_TIMEOUT_MS = 3 * 60 * 1000;

// Resolves true when the user picks a share target, false when the app
// comes back to the foreground without a pick (Android's chooser has no
// cancel callback — "picked" is the only positive signal it emits).
function waitForAndroidShareChoice(): Promise<boolean> {
  return new Promise((resolve) => {
    let graceTimer: number | null = null;
    let hardTimer: number | null = null;
    const settle = (chosen: boolean) => {
      window.removeEventListener(ANDROID_SHARE_CHOSEN_EVENT, onChosen);
      document.removeEventListener("visibilitychange", onVisibility);
      if (graceTimer !== null) window.clearTimeout(graceTimer);
      if (hardTimer !== null) window.clearTimeout(hardTimer);
      resolve(chosen);
    };
    const onChosen = () => settle(true);
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (graceTimer !== null) window.clearTimeout(graceTimer);
      graceTimer = window.setTimeout(
        () => settle(false),
        SHARE_RESUME_GRACE_MS,
      );
    };
    window.addEventListener(ANDROID_SHARE_CHOSEN_EVENT, onChosen);
    document.addEventListener("visibilitychange", onVisibility);
    hardTimer = window.setTimeout(() => settle(false), SHARE_CHOICE_TIMEOUT_MS);
  });
}

function saveBytesWeb(
  bytes: Uint8Array,
  options: SaveOptions,
): SaveResult {
  const blob = new Blob([new Uint8Array(bytes)], {
    type: options.mime ?? "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = options.suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  // The browser chose the destination (typically the Downloads folder);
  // we can't introspect it, so report the filename so the UI can at least
  // say "Saved as foo.pdf".
  return { status: "saved", path: options.suggestedName, platform: "web" };
}
