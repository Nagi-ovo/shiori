import { CAPABILITIES } from "./index";

export type EmbeddedTerminalSession = {
  sessionId: string;
  cwd: string;
};

export type EmbeddedTerminalOutput = {
  sessionId: string;
  data: string;
};

export type EmbeddedTerminalExit = {
  sessionId: string;
};

export type EmbeddedTerminalErrorCode =
  | "unsupported"
  | "unavailable"
  | "cwdUnavailable"
  | "cwdNotDirectory"
  | "sessionMissing"
  | "expired";

export class EmbeddedTerminalError extends Error {
  readonly code: EmbeddedTerminalErrorCode;

  constructor(code: EmbeddedTerminalErrorCode, message: string) {
    super(message);
    this.name = "EmbeddedTerminalError";
    this.code = code;
  }
}

export type EmbeddedTerminalSize = {
  cols: number;
  rows: number;
};

export function normalizeEmbeddedTerminalSize(
  cols: number,
  rows: number,
): EmbeddedTerminalSize {
  return {
    cols: Math.max(2, Math.min(400, Math.floor(cols))),
    rows: Math.max(2, Math.min(200, Math.floor(rows))),
  };
}

// xterm's onBinary event is a byte string: each UTF-16 code unit represents
// exactly one byte. Base64 keeps those bytes intact over Tauri's JSON IPC.
export function encodeEmbeddedTerminalBinary(data: string): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i);
    if (code > 0xff) {
      throw new RangeError("terminal-binary-byte-out-of-range");
    }
    binary += String.fromCharCode(code);
  }
  return btoa(binary);
}

export async function spawnEmbeddedTerminal(options: {
  sessionId: string;
  workingDirectory?: string | null;
  cols: number;
  rows: number;
}): Promise<EmbeddedTerminalSession> {
  if (!CAPABILITIES.embeddedTerminal) {
    throw new EmbeddedTerminalError("unsupported", "terminal-unsupported");
  }
  const { commands, unwrapCommand } = await import("./ipc");
  const size = normalizeEmbeddedTerminalSize(options.cols, options.rows);
  try {
    return unwrapCommand(
      await commands.terminalSpawn(
        options.sessionId,
        options.workingDirectory ?? null,
        size.cols,
        size.rows,
      ),
    );
  } catch (err) {
    throw new EmbeddedTerminalError(
      embeddedTerminalErrorCode(err),
      String(err instanceof Error ? err.message : err),
    );
  }
}

export async function writeEmbeddedTerminal(
  sessionId: string,
  data: string,
): Promise<void> {
  if (!CAPABILITIES.embeddedTerminal) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.terminalWrite(sessionId, data));
}

export async function writeEmbeddedTerminalBinary(
  sessionId: string,
  data: string,
): Promise<void> {
  if (!CAPABILITIES.embeddedTerminal) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(
    await commands.terminalWriteBinary(
      sessionId,
      encodeEmbeddedTerminalBinary(data),
    ),
  );
}

export async function resizeEmbeddedTerminal(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  if (!CAPABILITIES.embeddedTerminal) return;
  const { commands, unwrapCommand } = await import("./ipc");
  const size = normalizeEmbeddedTerminalSize(cols, rows);
  unwrapCommand(await commands.terminalResize(sessionId, size.cols, size.rows));
}

export async function killEmbeddedTerminal(sessionId: string): Promise<void> {
  if (!CAPABILITIES.embeddedTerminal) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.terminalKill(sessionId));
}

export async function listenEmbeddedTerminalOutput(
  handler: (event: EmbeddedTerminalOutput) => void,
): Promise<() => void> {
  if (!CAPABILITIES.embeddedTerminal) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<EmbeddedTerminalOutput>("terminal-output", (event) => {
    handler(event.payload);
  });
}

export async function listenEmbeddedTerminalExit(
  handler: (event: EmbeddedTerminalExit) => void,
): Promise<() => void> {
  if (!CAPABILITIES.embeddedTerminal) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<EmbeddedTerminalExit>("terminal-exit", (event) => {
    handler(event.payload);
  });
}

function embeddedTerminalErrorCode(err: unknown): EmbeddedTerminalErrorCode {
  const message = String(err instanceof Error ? err.message : err);
  if (message === "runtime-expired") return "expired";
  if (message === "terminal-cwd-unavailable") return "cwdUnavailable";
  if (message === "terminal-cwd-not-directory") return "cwdNotDirectory";
  if (message === "terminal-session-missing") return "sessionMissing";
  if (message === "terminal-unsupported") return "unsupported";
  return "unavailable";
}
