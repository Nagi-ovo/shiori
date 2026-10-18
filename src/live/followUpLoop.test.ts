// setupDom supplies the __APP_VERSION__ define that platform/index (pulled
// in via the embedded-terminal import chain) reads at module load.
import "../test/setupDom";
import { afterEach, describe, expect, test } from "bun:test";
import { useEditorStore } from "../editor/store/store";
import type { CalloutOverlay, PageModel } from "../pdf/model/types";
import {
  __followUpSessionsForTest,
  formatCalloutFollowUp,
  registerFollowUpTerminalSession,
  selectFollowUpTerminalSession,
  sendCalloutFollowUp,
  unregisterFollowUpTerminalSession,
} from "./followUpLoop";

const page: PageModel = {
  id: "page-1",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
};

const callout: CalloutOverlay = {
  type: "callout",
  id: "callout-1",
  pageId: page.id,
  targetRects: [{ x: 72, y: 650, w: 120, h: 20 }],
  rect: { x: 250, y: 620, w: 144, h: 54 },
  text: "root",
  fontSize: 12,
  color: "#b13a2e",
  bold: false,
  align: "left",
  fontFamily: "sans",
};

afterEach(() => {
  for (const id of __followUpSessionsForTest()) {
    unregisterFollowUpTerminalSession(id);
  }
});

describe("callout follow-up loop", () => {
  test("formats a single pty-safe line, question first, id where it is used", () => {
    const line = formatCalloutFollowUp(
      "callout-1",
      4,
      "  推导在哪？\n帮我标出来  ",
    );
    // One line: embedded newlines would submit the prompt early.
    expect(line).not.toContain("\n");
    expect(line).toBe(
      ": Shiori follow up from the reader on page 4: “推导在哪？ 帮我标出来” — " +
        "run shiori app context to read this callout and its thread, then " +
        "answer by running shiori app annotate --spec with a calloutReply " +
        "to callout callout-1, see shiori help spec",
    );
    // Read before write: the injected line carries only the new turn, so the
    // agent must be told where the rest of the conversation lives.
    expect(line).toContain("shiori app context");
    // Names the command, not just the concept: an agent with no Shiori
    // context cannot act on "calloutReply" alone.
    expect(formatCalloutFollowUp("c", null, "hi")).toContain(
      "shiori app annotate --spec",
    );
    expect(formatCalloutFollowUp("c", null, "hi")).toContain(
      "Shiori follow up from the reader: “hi”",
    );
  });

  test("writes the text and the submit key as separate chunks", async () => {
    useEditorStore.setState({ model: { pages: [page], overlays: [callout] } });
    registerFollowUpTerminalSession("term-old");
    registerFollowUpTerminalSession("term-new");
    const writes: Array<[string, string]> = [];
    const result = sendCalloutFollowUp(
      callout,
      { id: "t1", role: "user", text: "推导在哪？" },
      {
        editorStore: useEditorStore,
        write: async (sessionId, data) => {
          writes.push([sessionId, data]);
        },
      },
    );
    expect(result).toBe("sent");

    // First chunk is the text alone — a trailing CR in the SAME write is
    // read by a raw-mode TUI as literal text, filling the prompt without
    // ever submitting it.
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe("term-new");
    expect(writes[0]![1]).not.toContain("\r");
    expect(writes[0]![1]).toContain("on page 1");

    await Promise.resolve();
    expect(writes[1]).toEqual(["term-new", "\r"]);

    // A dead newest session falls back to the previous one.
    unregisterFollowUpTerminalSession("term-new");
    sendCalloutFollowUp(
      callout,
      { id: "t2", role: "user", text: "again" },
      {
        editorStore: useEditorStore,
        write: async (sessionId, data) => {
          writes.push([sessionId, data]);
        },
      },
    );
    await Promise.resolve();
    expect(writes[2]![0]).toBe("term-old");
  });

  test("does not submit into a session that closed during the gap", async () => {
    useEditorStore.setState({ model: { pages: [page], overlays: [callout] } });
    registerFollowUpTerminalSession("term-closing");
    const writes: Array<[string, string]> = [];
    let releaseFirstWrite: (() => void) | null = null;
    sendCalloutFollowUp(
      callout,
      { id: "t1", role: "user", text: "hello" },
      {
        editorStore: useEditorStore,
        write: (sessionId, data) => {
          writes.push([sessionId, data]);
          return new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        },
      },
    );
    unregisterFollowUpTerminalSession("term-closing");
    releaseFirstWrite?.();
    await Promise.resolve();
    // Only the text write happened; the CR never lands in a dead session.
    expect(writes).toHaveLength(1);
  });

  test("goes to the selected terminal, not the one that spawned last", async () => {
    // The rail can hold several terminals, and switching tabs respawns
    // nothing — so a reader who opens a second terminal and switches back
    // must not have their follow-up injected into the hidden one.
    useEditorStore.setState({ model: { pages: [page], overlays: [callout] } });
    registerFollowUpTerminalSession("term-first");
    registerFollowUpTerminalSession("term-second");
    selectFollowUpTerminalSession("term-first");
    const writes: Array<[string, string]> = [];
    const result = sendCalloutFollowUp(
      callout,
      { id: "t1", role: "user", text: "which one?" },
      {
        editorStore: useEditorStore,
        write: async (sessionId, data) => {
          writes.push([sessionId, data]);
        },
      },
    );
    expect(result).toBe("sent");
    await Promise.resolve();
    expect(writes[0]![0]).toBe("term-first");
  });

  test("falls back to the most recent session when the selected one died", async () => {
    useEditorStore.setState({ model: { pages: [page], overlays: [callout] } });
    registerFollowUpTerminalSession("term-first");
    registerFollowUpTerminalSession("term-second");
    selectFollowUpTerminalSession("term-first");
    unregisterFollowUpTerminalSession("term-first");
    const writes: Array<[string, string]> = [];
    const result = sendCalloutFollowUp(
      callout,
      { id: "t1", role: "user", text: "still somewhere" },
      {
        editorStore: useEditorStore,
        write: async (sessionId, data) => {
          writes.push([sessionId, data]);
        },
      },
    );
    expect(result).toBe("sent");
    await Promise.resolve();
    expect(writes[0]![0]).toBe("term-second");
  });

  test("reports no-terminal without losing anything when nothing is live", () => {
    const writes: string[] = [];
    const result = sendCalloutFollowUp(
      callout,
      { id: "t1", role: "user", text: "hello" },
      {
        editorStore: useEditorStore,
        write: async (_sessionId, data) => {
          writes.push(data);
        },
      },
    );
    expect(result).toBe("no-terminal");
    expect(writes).toHaveLength(0);
  });
});

describe("terminal safety of injected text", () => {
  test("falls back to an inert shell command when the agent has exited", () => {
    const line = formatCalloutFollowUp(
      "c1",
      3,
      '"; printf PWNED; # and $(touch /tmp/pwned) with `whoami`',
    );

    // A live PTY can outlive the agent and fall back to the user's shell.
    // Prefix the whole human-readable instruction with the no-op `:` builtin,
    // then remove every token that could terminate its argument list, expand
    // input, redirect, glob, or start another command.
    expect(line).toStartWith(": Shiori follow up");
    for (const shellToken of [
      "\\",
      '"',
      "'",
      "`",
      "$",
      ";",
      "&",
      "|",
      "<",
      ">",
      "(",
      ")",
      "{",
      "}",
      "[",
      "]",
      "*",
      "?",
      "!",
      "#",
    ]) {
      expect(line).not.toContain(shellToken);
    }
    // The safety transform must preserve the question rather than silently
    // deleting it; only punctuation is replaced with readable Unicode forms.
    expect(line).toContain("printf PWNED");
    expect(line).toContain("touch /tmp/pwned");
    expect(line).toContain("whoami");
  });

  test("neutralises command substitution in a callout body", () => {
    // The line is submitted with a carriage return. A session whose agent has
    // exited is at a shell prompt, and the shell evaluates substitutions
    // before failing on the line as a whole.
    const line = formatCalloutFollowUp(
      "c1",
      3,
      "what does `rm -rf ~` do, and $(whoami), and ${HOME}?",
    );

    expect(line).not.toContain("`");
    expect(line).not.toContain("$(");
    expect(line).not.toContain("${");
    // Still readable.
    expect(line).toContain("rm -rf ~");
    expect(line).toContain("whoami");
  });

  test("strips control characters that would reach the terminal renderer", () => {
    const escape = String.fromCharCode(27);
    const line = formatCalloutFollowUp(
      "c1",
      null,
      `before${escape}[31mred${escape}[0mafter`,
    );

    expect(line).not.toContain(escape);
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(line).toContain("before");
    expect(line).toContain("after");
  });
});
