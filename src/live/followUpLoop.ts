import type { PdfEditorStoreApi } from "../editor/store/store";
import { writeEmbeddedTerminal } from "../platform/embeddedTerminal";
import type { CalloutOverlay, CalloutThreadEntry } from "../pdf/model/types";

// The follow-up loop (P4 of docs/PLAN-agent-native.md): a user turn typed
// into a callout's conversation panel is injected into the embedded
// terminal's stdin — exactly as if the user had typed it there — so the
// agent session running in that terminal wakes up and can answer with a
// calloutReply. This is the whole mechanism: no protocol, no push channel,
// and nothing happens invisibly — the injected line is plainly visible in
// the terminal.
//
// MCP was considered and rejected for this: its notifications cannot make
// an idle agent start a turn (see the plan's P4 section).

// Two separate facts, and conflating them sent turns to the wrong terminal.
// `activeSessions` is every session whose pty is alive; `selectedSession` is
// the one the reader is actually looking at. The rail can hold several
// terminals, and selecting a tab does not respawn anything — so "most
// recently spawned" is not "the one on screen". A follow-up goes to the
// terminal the user can see, or it lands in a hidden session and interrupts
// an unrelated agent.
const activeSessions: string[] = [];
let selectedSession: string | null = null;

export function registerFollowUpTerminalSession(sessionId: string): void {
  unregisterFollowUpTerminalSession(sessionId);
  activeSessions.push(sessionId);
}

export function unregisterFollowUpTerminalSession(sessionId: string): void {
  const index = activeSessions.indexOf(sessionId);
  if (index >= 0) activeSessions.splice(index, 1);
  if (selectedSession === sessionId) selectedSession = null;
}

/**
 * The session the rail is currently showing. Pass null when no terminal is
 * on screen; dispatch then falls back to the most recent live session, which
 * is the right answer when there is only one.
 */
export function selectFollowUpTerminalSession(sessionId: string | null): void {
  selectedSession = sessionId;
}

/** The session a follow-up would be injected into right now, if any. */
function dispatchTarget(): string | undefined {
  if (selectedSession && activeSessions.includes(selectedSession)) {
    return selectedSession;
  }
  return activeSessions.at(-1);
}

// A pty line submits on \r; embedded newlines would fire the prompt early,
// so the turn is flattened to one line. Generous cap — this is a question,
// not a document.
const MAX_INJECTED_CHARACTERS = 4_000;

// Reads as an instruction a person would type, not a log line: the question
// comes first in quotes, and the callout id sits at the end where it is
// actually used — it is the `replyTo` argument, not decoration.
//
// It must also be self-bootstrapping. An agent with no Shiori context has no
// idea what a "calloutReply" is, so the line names the command that writes
// one and points at the CLI's own help — which is the whole reason the
// command contract self-describes (see skills/shiori/SKILL.md). Without
// that, the agent answers in the terminal and nothing reaches the page.
//
// The line carries the new turn only, never the thread — a long conversation
// would blow the character cap and bury the terminal. It points at
// `shiori app context` instead, which returns the callout's body, its
// anchored quote and every turn, so the agent pulls exactly what it needs.
/**
 * Make an annotation body safe to write into a pty.
 *
 * Normally the far end is a TUI, which treats this as literal input. But a
 * session whose agent has exited is sitting at a shell prompt, and the line
 * is submitted with a carriage return. The complete line therefore has to be
 * valid as one harmless shell command, not merely unlikely to execute. It is
 * prefixed with the `:` no-op by formatCalloutFollowUp; this transform replaces
 * every ASCII token that could escape its argument list, expand input,
 * redirect, glob, or start another command. Control characters are a second
 * channel: a pasted ANSI sequence would reach the terminal renderer verbatim.
 *
 * Not a remote-injection surface — the text is the reader's own annotation
 * on their own machine — but the reader did not intend to run anything, and
 * a body can arrive by paste from anywhere.
 */
function neutralizeForTerminal(value: string): string {
  return (
    value
      // C0 and C1, including ESC.
      // eslint-disable-next-line no-control-regex -- matching them is the point
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      // Preserve readable punctuation with Unicode lookalikes. ASCII shell
      // syntax is deliberately absent from the final line.
      .replace(/[\\'"`$;&|<>(){}[\]*?!#]/g, (token) =>
        SHELL_META_REPLACEMENTS[token] ?? " ",
      )
  );
}

const SHELL_META_REPLACEMENTS: Readonly<Record<string, string>> = {
  "\\": "＼",
  "'": "’",
  '"': "”",
  "`": "ˋ",
  $: "＄",
  ";": "；",
  "&": "＆",
  "|": "｜",
  "<": "＜",
  ">": "＞",
  "(": "（",
  ")": "）",
  "{": "｛",
  "}": "｝",
  "[": "［",
  "]": "］",
  "*": "＊",
  "?": "？",
  "!": "！",
  "#": "＃",
};

export function formatCalloutFollowUp(
  calloutId: string,
  pageNumber: number | null,
  text: string,
): string {
  const flattened = neutralizeForTerminal(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_INJECTED_CHARACTERS);
  const where = pageNumber ? ` on page ${pageNumber}` : "";
  const safeCalloutId = neutralizeForTerminal(calloutId)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 256);
  return (
    `: Shiori follow up from the reader${where}: “${flattened}” — ` +
    `run shiori app context to read this callout and its thread, then ` +
    `answer by running shiori app annotate --spec with a calloutReply ` +
    `to callout ${safeCalloutId}, see shiori help spec`
  );
}

export type FollowUpDispatch = "sent" | "no-terminal";

// The submit key must arrive as its OWN pty write. A TUI in raw mode (Ink,
// which Claude Code is built on) turns each readable chunk into one input
// event: "text\r" in a single write is read as text that happens to end in
// a carriage return and is inserted literally, so the prompt fills but
// never submits. Awaiting the first IPC write provides ordering and backpressure
// without a timing guess that can still race on a busy machine.

/**
 * Injects a user turn into the most recent embedded terminal session and
 * submits it, so the agent session running there starts a turn.
 *
 * Returns "no-terminal" when no session is alive — the turn still lives on
 * the callout, so nothing is lost; the caller may tell the user an agent
 * would have picked it up.
 */
export function sendCalloutFollowUp(
  overlay: CalloutOverlay,
  entry: CalloutThreadEntry,
  {
    editorStore,
    write = writeEmbeddedTerminal,
  }: {
    editorStore: PdfEditorStoreApi;
    write?: (sessionId: string, data: string) => Promise<void>;
  },
): FollowUpDispatch {
  const sessionId = dispatchTarget();
  if (!sessionId) return "no-terminal";
  const pageIndex = editorStore
    .getState()
    .model.pages.findIndex((page) => page.id === overlay.pageId);
  const line = formatCalloutFollowUp(
    overlay.id,
    pageIndex >= 0 ? pageIndex + 1 : null,
    entry.text,
  );
  void (async () => {
    try {
      await write(sessionId, line);
      // Only submit into the session that actually took the text; the user
      // may have closed the terminal while that ordered IPC write was in flight.
      if (!activeSessions.includes(sessionId)) return;
      await write(sessionId, "\r");
    } catch {
      // The turn already lives on the callout. Terminal teardown and transport
      // errors must not turn a persisted user reply into an unhandled rejection.
    }
  })();
  return "sent";
}

// Test seam: assertions about the registry without touching module state
// from the outside.
export function __followUpSessionsForTest(): readonly string[] {
  return [...activeSessions];
}
