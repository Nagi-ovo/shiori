const STORAGE_KEY = "shiori:lastTextEditDebug";

export type TextEditDebugPayload = {
  capturedAt: string;
  page: {
    id: string;
    sourceIndex: number;
    widthPt: number;
    heightPt: number;
    rotation: number;
    scale: number;
  };
  selection: unknown;
  overlay: unknown;
};

declare global {
  interface Window {
    __SHIORI_LAST_TEXT_EDIT_DEBUG__?: TextEditDebugPayload;
    copyShioriTextEditDebug?: () => Promise<boolean>;
    printShioriTextEditDebug?: () => boolean;
  }
}

let lastPayload: TextEditDebugPayload | null = null;
let installedGlobalCopy = false;

export function recordTextEditDebug(payload: TextEditDebugPayload): void {
  lastPayload = payload;
  if (typeof window !== "undefined") {
    window.__SHIORI_LAST_TEXT_EDIT_DEBUG__ = payload;
    installGlobalCopyHelper();
  }
  const text = formatTextEditDebug(payload);
  try {
    localStorage.setItem(STORAGE_KEY, text);
  } catch {
    // Storage can be unavailable in restricted contexts. The global value
    // and console log still keep the diagnostic recoverable.
  }
  printTextEditDebug(text);
}

export async function copyLastTextEditDebug(): Promise<boolean> {
  const text = lastPayload
    ? formatTextEditDebug(lastPayload)
    : readStoredTextEditDebug();
  if (!text) return false;
  return copyText(text);
}

export function getLastTextEditDebugText(): string | null {
  if (lastPayload) return formatTextEditDebug(lastPayload);
  return readStoredTextEditDebug();
}

function formatTextEditDebug(payload: TextEditDebugPayload): string {
  return JSON.stringify(
    {
      kind: "shiori.textEditSelectionDebug",
      ...payload,
    },
    null,
    2,
  );
}

function readStoredTextEditDebug(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function installGlobalCopyHelper(): void {
  if (installedGlobalCopy) return;
  installedGlobalCopy = true;
  window.copyShioriTextEditDebug = copyLastTextEditDebug;
  window.printShioriTextEditDebug = printLastTextEditDebug;
}

function printLastTextEditDebug(): boolean {
  const text = getLastTextEditDebugText();
  if (!text) return false;
  printTextEditDebug(text);
  return true;
}

function printTextEditDebug(text: string): void {
  console.info(`[Shiori text edit debug]\n${text}`);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return fallbackCopyText(text);
  }
}

function fallbackCopyText(text: string): boolean {
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "true");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  document.body.append(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}
