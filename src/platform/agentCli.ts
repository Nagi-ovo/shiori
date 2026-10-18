import { IS_TAURI_DESKTOP } from "./index";

export type AgentCliAvailability = {
  claudeCode: boolean;
  codex: boolean;
};

const NONE: AgentCliAvailability = Object.freeze({
  claudeCode: false,
  codex: false,
});

let detection: Promise<AgentCliAvailability> | null = null;

export function normalizeAgentCliAvailability(
  value: unknown,
): AgentCliAvailability {
  if (typeof value !== "object" || value === null) return NONE;
  return {
    claudeCode:
      "claudeCode" in value && typeof value.claudeCode === "boolean"
        ? value.claudeCode
        : false,
    codex:
      "codex" in value && typeof value.codex === "boolean"
        ? value.codex
        : false,
  };
}

export function hasAgentCli(availability: AgentCliAvailability): boolean {
  return availability.claudeCode || availability.codex;
}

/**
 * One cached, asynchronous native probe per app launch. Until it resolves the
 * UI treats follow-up as unavailable, so an unsupported control never flashes.
 */
export function detectAgentClis(): Promise<AgentCliAvailability> {
  if (!IS_TAURI_DESKTOP) return Promise.resolve(NONE);
  if (detection) return detection;
  detection = (async () => {
    const { commands, unwrapCommand } = await import("./ipc");
    return normalizeAgentCliAvailability(
      unwrapCommand(await commands.detectAgentClis()),
    );
  })().catch(() => NONE);
  return detection;
}

export function __resetAgentCliDetectionForTest(): void {
  detection = null;
}
