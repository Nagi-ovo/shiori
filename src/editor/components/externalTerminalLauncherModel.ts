import type {
  ExternalTerminalApp,
  ExternalTerminalId,
} from "../../platform/externalTerminal";

export type { ExternalTerminalApp } from "../../platform/externalTerminal";

export function resolvePreferredExternalTerminal(
  terminals: ExternalTerminalApp[],
  preferredId: ExternalTerminalId | null,
): ExternalTerminalApp | null {
  if (terminals.length === 0) return null;
  return (
    terminals.find((terminal) => terminal.id === preferredId) ??
    terminals[0] ??
    null
  );
}
