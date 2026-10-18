import { IS_TAURI_DESKTOP } from "./index";

export const EXTERNAL_TERMINAL_IDS = [
  "terminal",
  "ghostty",
  "iterm2",
  "wezterm",
  "windowsTerminal",
  "systemTerminal",
] as const;

export type ExternalTerminalId = (typeof EXTERNAL_TERMINAL_IDS)[number];

export type ExternalTerminalApp = {
  id: ExternalTerminalId;
  name: string;
  iconDataUrl?: string | null;
};

const EXTERNAL_TERMINAL_ID_SET = new Set<string>(EXTERNAL_TERMINAL_IDS);
const EXTERNAL_TERMINAL_ICON_PREFIX = "data:image/png;base64,";
const MAX_EXTERNAL_TERMINAL_ICON_DATA_URL_LENGTH = 700_000;

export function isExternalTerminalId(value: unknown): value is ExternalTerminalId {
  return typeof value === "string" && EXTERNAL_TERMINAL_ID_SET.has(value);
}

export function normalizeExternalTerminalIconDataUrl(
  value: unknown,
): string | null {
  if (
    typeof value !== "string" ||
    value.length > MAX_EXTERNAL_TERMINAL_ICON_DATA_URL_LENGTH ||
    !value.startsWith(EXTERNAL_TERMINAL_ICON_PREFIX)
  ) {
    return null;
  }
  const payload = value.slice(EXTERNAL_TERMINAL_ICON_PREFIX.length);
  if (
    !payload.startsWith("iVBORw0KGgo") ||
    payload.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)
  ) {
    return null;
  }
  return value;
}

export function normalizeExternalTerminalApps(
  value: unknown,
): ExternalTerminalApp[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ExternalTerminalId>();
  const apps: ExternalTerminalApp[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      !("name" in entry) ||
      !isExternalTerminalId(entry.id) ||
      typeof entry.name !== "string" ||
      entry.name.trim() === "" ||
      seen.has(entry.id)
    ) {
      continue;
    }
    seen.add(entry.id);
    const iconDataUrl =
      "iconDataUrl" in entry
        ? normalizeExternalTerminalIconDataUrl(entry.iconDataUrl)
        : null;
    apps.push({
      id: entry.id,
      name: entry.name,
      ...(iconDataUrl ? { iconDataUrl } : {}),
    });
  }
  return apps;
}

export function normalizeExternalTerminalWorkingDirectory(
  value: string | null | undefined,
): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export async function listExternalTerminals(): Promise<ExternalTerminalApp[]> {
  if (!IS_TAURI_DESKTOP) return [];
  const { commands, unwrapCommand } = await import("./ipc");
  const result = unwrapCommand(await commands.listExternalTerminals());
  return normalizeExternalTerminalApps(result);
}

export async function openExternalTerminal(
  terminalId: ExternalTerminalId,
  workingDirectory?: string | null,
): Promise<void> {
  if (!IS_TAURI_DESKTOP) {
    throw new Error("external-terminal-unsupported");
  }
  if (!isExternalTerminalId(terminalId)) {
    throw new Error("external-terminal-unknown-id");
  }
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(
    await commands.openExternalTerminal(
      terminalId,
      normalizeExternalTerminalWorkingDirectory(workingDirectory),
    ),
  );
}
