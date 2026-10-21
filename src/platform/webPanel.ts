// Embedded Browser panel — desktop only.
//
// The web content is rendered by a native child webview owned by Rust
// (Tauri `unstable` multi-webview, see src-tauri/src/lib.rs). It is NOT an
// iframe: arbitrary sites (github, google, …) set X-Frame-Options /
// frame-ancestors and cannot be framed, and our CSP blocks remote frames.
//
// A native webview is an OS-level layer that ignores DOM stacking and
// clipping, so the React side owns its geometry: the Browser tab reports
// the host element's rect (CSS / logical px, relative to the window's
// top-left) and Rust positions the webview to match. When the Browser tab
// is not visible the webview is hidden.
//
// Remote pages are NOT granted Shiori's file/pdf/terminal commands — that
// isolation lives in the webview's scoped capability on the Rust side.

import { CAPABILITIES, IS_TAURI_MOBILE } from "./index";
import { openExternalUrl } from "./external";
import { isWebPanelUrl } from "./webPanelUrl";

export { isWebPanelUrl, resolveAddressBarInput } from "./webPanelUrl";

// Geometry for the native webview, in CSS / logical px relative to the
// window content's top-left. Tauri scales these by the monitor DPR.
export type WebPanelBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// Nav-state pushed from Rust as the panel navigates. `url` is the live
// committed URL (reflected back into the address bar); `loading` is a
// best-effort hint (Rust signals start-of-navigation, the UI clears it on
// the next committed nav or a safety timeout).
export type WebPanelNavState = {
  url: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
};

// Buttons for the page's JavaScript alert/confirm/prompt. iOS draws those
// dialogs itself and has no t(); the other engines show their own.
export type WebPanelDialogLabels = { ok: string; cancel: string };

// Open `url` in the embedded panel. Non-http(s) URLs fall back to the
// system browser. On the web build there is no native panel, so every URL
// opens in a new browser tab.
export async function openUrlInWebPanel(
  url: string,
  bounds?: WebPanelBounds | null,
  persistSession = true,
  dialogLabels: WebPanelDialogLabels | null = null,
): Promise<void> {
  if (!isWebPanelUrl(url)) {
    await openUrlInSystemBrowser(url);
    return;
  }
  if (!CAPABILITIES.embeddedBrowserPanel) {
    await openUrlInSystemBrowser(url);
    return;
  }
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(
    await commands.webPanelOpen(url, bounds ?? null, persistSession, dialogLabels),
  );
}

export async function navigateWebPanel(url: string): Promise<void> {
  if (!isWebPanelUrl(url)) {
    await openUrlInSystemBrowser(url);
    return;
  }
  if (!CAPABILITIES.embeddedBrowserPanel) {
    await openUrlInSystemBrowser(url);
    return;
  }
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.webPanelNavigate(url));
}

export async function setWebPanelBounds(bounds: WebPanelBounds): Promise<void> {
  if (!CAPABILITIES.embeddedBrowserPanel) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.webPanelSetBounds(bounds));
}

export async function hideWebPanel(): Promise<void> {
  if (!CAPABILITIES.embeddedBrowserPanel) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.webPanelHide());
}

export async function webPanelBack(): Promise<void> {
  if (!CAPABILITIES.embeddedBrowserPanel) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.webPanelBack());
}

export async function webPanelForward(): Promise<void> {
  if (!CAPABILITIES.embeddedBrowserPanel) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.webPanelForward());
}

export async function webPanelReload(): Promise<void> {
  if (!CAPABILITIES.embeddedBrowserPanel) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.webPanelReload());
}

export async function closeWebPanel(): Promise<void> {
  if (!CAPABILITIES.embeddedBrowserPanel) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.webPanelClose());
}

// "Open in system browser" affordance — always the OS default browser.
export async function openUrlInSystemBrowser(url: string): Promise<void> {
  await openExternalUrl(url);
}

// Rust pushes nav-state updates as the panel navigates.
export async function listenWebPanelNav(
  handler: (state: WebPanelNavState) => void,
): Promise<() => void> {
  if (!CAPABILITIES.embeddedBrowserPanel) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<WebPanelNavState>("web-panel-nav", (event) => {
    handler(event.payload);
  });
}

// Rust emits this when something outside the React UI asks to open a URL
// in the panel — today that is the terminal `open https://…` shim writing
// to the Shiori pipe.
export async function listenWebPanelOpenRequest(
  handler: (url: string) => void,
): Promise<() => void> {
  if (!CAPABILITIES.embeddedBrowserPanel) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ url: string }>("web-panel-open", (event) => {
    handler(event.payload.url);
  });
}

// A page in the panel navigated to a mailto: link (or, on mobile, tel:).
// The native side cancels it and reports it here instead of opening it, so
// the user can be asked first (src/editor/components/browserExternalOpen.ts).
export async function listenWebPanelExternalOpen(
  handler: (url: string) => void,
): Promise<() => void> {
  if (!CAPABILITIES.embeddedBrowserPanel) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ url: string }>("web-panel-external-open", (event) => {
    handler(event.payload.url);
  });
}

export type ExternalOpenPromptText = {
  title: string;
  message: string;
  open: string;
  cancel: string;
};

// A native dialog, not a DOM modal: the panel's webview is an OS layer that
// would sit on top of anything the page renders.
export async function askToOpenExternally(text: ExternalOpenPromptText): Promise<boolean> {
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(text.message, {
    title: text.title,
    kind: "warning",
    okLabel: text.open,
    cancelLabel: text.cancel,
  });
}

const PANEL_EXTERNAL_URL = /^(mailto|tel):/i;

// Open a link the user agreed to hand off. Desktop only ever reports mailto:
// (open_external_url accepts it); mobile goes through the opener plugin,
// whose default scope covers mailto: and tel:.
export async function openWebPanelExternalUrl(url: string): Promise<void> {
  if (!PANEL_EXTERNAL_URL.test(url)) throw new Error("unsupported-external-url");
  if (IS_TAURI_MOBILE) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  await openExternalUrl(url);
}
