export const EMBEDDED_TERMINAL_FONT_FAMILY =
  "'JetBrains Mono', 'Shiori Nerd Symbols', 'SF Mono', Menlo, Consolas, monospace";

// These are behavior defaults for a real PTY-backed terminal. In particular,
// LF -> CRLF conversion belongs to the PTY's termios settings; enabling
// xterm's convertEol on top can produce duplicate-looking line movement.
export const EMBEDDED_TERMINAL_OPTIONS = {
  allowProposedApi: false,
  convertEol: false,
  cursorBlink: true,
  cursorStyle: "block",
  disableStdin: false,
  fontFamily: EMBEDDED_TERMINAL_FONT_FAMILY,
  fontSize: 12,
  macOptionIsMeta: true,
  // The shell owns the active cursor line and redraws it after SIGWINCH.
  // Reflowing that line in xterm as well can corrupt multi-line prompts.
  reflowCursorLine: false,
  scrollback: 8_000,
} as const;

export const EMBEDDED_TERMINAL_RESIZE_DELAY_MS = 180;

export type TerminalResizeRequest = {
  sessionId: string;
  cols: number;
  rows: number;
};

export type TerminalResizeTimers = {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
};

export type TerminalResizeScheduler = {
  markDelivered(request: TerminalResizeRequest): void;
  schedule(request: TerminalResizeRequest): void;
  cancel(): void;
};

const DEFAULT_RESIZE_TIMERS: TerminalResizeTimers = {
  set(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clear(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

function sameResizeRequest(
  a: TerminalResizeRequest | null,
  b: TerminalResizeRequest,
): boolean {
  return (
    a?.sessionId === b.sessionId && a.cols === b.cols && a.rows === b.rows
  );
}

function normalizeResizeRequest(
  request: TerminalResizeRequest,
): TerminalResizeRequest {
  return {
    sessionId: request.sessionId,
    cols: Math.max(2, Math.min(400, Math.floor(request.cols))),
    rows: Math.max(2, Math.min(200, Math.floor(request.rows))),
  };
}

// Keep xterm's local grid responsive on every animation frame, but collapse
// the expensive PTY resize/SIGWINCH path to the final size after dragging.
// The Rust side independently deduplicates as a second line of defense.
export function createTrailingTerminalResize(
  deliver: (request: TerminalResizeRequest) => void,
  delayMs = EMBEDDED_TERMINAL_RESIZE_DELAY_MS,
  timers: TerminalResizeTimers = DEFAULT_RESIZE_TIMERS,
): TerminalResizeScheduler {
  let timer: unknown = null;
  let pending: TerminalResizeRequest | null = null;
  let delivered: TerminalResizeRequest | null = null;

  const clearTimer = () => {
    if (timer == null) return;
    timers.clear(timer);
    timer = null;
  };

  const flush = () => {
    timer = null;
    const request = pending;
    pending = null;
    if (!request || sameResizeRequest(delivered, request)) return;
    delivered = request;
    deliver(request);
  };

  return {
    markDelivered(request) {
      request = normalizeResizeRequest(request);
      delivered = request;
      if (!sameResizeRequest(pending, request)) return;
      pending = null;
      clearTimer();
    },
    schedule(request) {
      request = normalizeResizeRequest(request);
      if (sameResizeRequest(pending, request)) return;
      if (sameResizeRequest(delivered, request)) {
        pending = null;
        clearTimer();
        return;
      }
      pending = request;
      clearTimer();
      timer = timers.set(flush, delayMs);
    },
    cancel() {
      pending = null;
      clearTimer();
    },
  };
}

export async function preloadEmbeddedTerminalFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    // The sample includes both a Powerline separator and a common Nerd Font
    // home icon, forcing the bundled fallback to be ready before xterm's first
    // glyph measurement/paint.
    await document.fonts.load(
      `400 ${EMBEDDED_TERMINAL_OPTIONS.fontSize}px "Shiori Nerd Symbols"`,
      "\ue0b0\uf015",
    );
  } catch {
    // Font loading is an enhancement: a failed local asset must not prevent a
    // user from reaching their shell. The normal system fallback still runs.
  }
}
