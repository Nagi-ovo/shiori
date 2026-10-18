import { isValidMarkdownFontFamily } from "../documents/markdownAppearance";
import { IS_TAURI_DESKTOP, IS_TAURI_MOBILE } from "./index";

export type SystemFontFamily = {
  family: string;
  aliases: string[];
  monospaced: boolean;
};

export type SystemFontListResult =
  | {
      status: "available";
      source: "desktop" | "web";
      fonts: SystemFontFamily[];
    }
  | {
      status: "unsupported" | "denied" | "error";
      source: "mobile" | "web" | "desktop";
      fonts: [];
    };

type LocalFontData = {
  family?: unknown;
};

type WindowWithLocalFonts = Window & {
  queryLocalFonts?: () => Promise<LocalFontData[]>;
};

const SYSTEM_FONT_LIMIT = 4096;
const SYSTEM_FONT_ALIAS_LIMIT = 16;

function fontKey(family: string): string {
  return family.toLowerCase();
}

function normalizeAliases(value: unknown, family: string): string[] {
  if (!Array.isArray(value)) return [];
  const familyKey = fontKey(family);
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const entry of value) {
    if (!isValidMarkdownFontFamily(entry)) continue;
    const key = fontKey(entry);
    if (key === familyKey || seen.has(key)) continue;
    seen.add(key);
    aliases.push(entry);
    if (aliases.length >= SYSTEM_FONT_ALIAS_LIMIT) break;
  }
  return aliases.sort((left, right) => left.localeCompare(right));
}

export function normalizeSystemFontFamilies(
  value: unknown,
): SystemFontFamily[] {
  if (!Array.isArray(value)) return [];
  const byFamily = new Map<string, SystemFontFamily>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (!isValidMarkdownFontFamily(raw.family)) continue;
    if (raw.family.startsWith(".")) continue;
    const key = fontKey(raw.family);
    const aliases = normalizeAliases(raw.aliases, raw.family);
    const existing = byFamily.get(key);
    if (existing) {
      existing.monospaced ||= raw.monospaced === true;
      existing.aliases = normalizeAliases(
        [...existing.aliases, ...aliases],
        existing.family,
      );
      continue;
    }
    byFamily.set(key, {
      family: raw.family,
      aliases,
      monospaced: raw.monospaced === true,
    });
    if (byFamily.size >= SYSTEM_FONT_LIMIT) break;
  }
  return [...byFamily.values()].sort((left, right) =>
    left.family.localeCompare(right.family),
  );
}

export function normalizeWebLocalFonts(value: unknown): SystemFontFamily[] {
  if (!Array.isArray(value)) return [];
  return normalizeSystemFontFamilies(
    value.map((entry) => ({
      family:
        entry && typeof entry === "object"
          ? (entry as LocalFontData).family
          : undefined,
      aliases: [],
      monospaced: false,
    })),
  );
}

function localFontErrorStatus(error: unknown): "denied" | "error" {
  if (error && typeof error === "object" && "name" in error) {
    const name = String((error as { name: unknown }).name);
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "denied";
    }
  }
  return "error";
}

// Must be called directly from the font-button click path on the Web. The
// Local Font Access API requires transient user activation before prompting.
export async function listSystemFonts(): Promise<SystemFontListResult> {
  if (IS_TAURI_DESKTOP) {
    try {
      const { commands, unwrapCommand } = await import("./ipc");
      const result = unwrapCommand(await commands.listSystemFonts());
      return {
        status: "available",
        source: "desktop",
        fonts: normalizeSystemFontFamilies(result),
      };
    } catch {
      return { status: "error", source: "desktop", fonts: [] };
    }
  }

  if (IS_TAURI_MOBILE || typeof window === "undefined") {
    return { status: "unsupported", source: "mobile", fonts: [] };
  }

  const queryLocalFonts = (window as WindowWithLocalFonts).queryLocalFonts;
  if (typeof queryLocalFonts !== "function") {
    return { status: "unsupported", source: "web", fonts: [] };
  }

  try {
    const fonts = await queryLocalFonts.call(window);
    return {
      status: "available",
      source: "web",
      fonts: normalizeWebLocalFonts(fonts),
    };
  } catch (error) {
    return {
      status: localFontErrorStatus(error),
      source: "web",
      fonts: [],
    };
  }
}
