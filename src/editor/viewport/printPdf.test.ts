import { describe, expect, test } from "bun:test";
import type { PdfSecurity } from "../../pdf/engine/types";
import type { PrintableResult } from "../../pdf/export/printablePdf";
import { fakeClock } from "../../test/fakeClock";
import { runPrint, type PrintFrame, type PrintPorts } from "./printPdf";

// What can go wrong between "print" and the browser's print frame:
// - permissions: the opening password refuses printing (bit 3), or the
//   engine cannot report the security at all — either must stop before any
//   export runs, and the reader hears which one it was;
// - the export refuses the source (signed, permission, security unknown)
//   and the reader hears a message that names the actual cause in print
//   terms (an export message about "changes" is wrong for a print);
// - the export fails for another reason and the reader hears nothing;
// - characters the fonts cannot draw: the reader declines and something is
//   still mounted, or a URL is still created;
// - the browser refuses print() (popup blocker): the fallback window opens,
//   and when it is blocked too the reader hears nothing;
// - cleanup: afterprint (on the window or the frame) must remove the frame,
//   revoke the blob URL and restore the title, exactly once; when afterprint
//   never fires, the 30 s timeout must; a frame that fails to load must too;
// - the document leaves the screen (tab switch) during the export, during
//   the lost-characters prompt or before the frame loads: nothing may print
//   and no frame may stay behind;
// - the run never settles, so the busy indicator stays on.

const ALL: PdfSecurity = { revision: 6, permissions: 0xfffffffc, userPermissions: 0xfffffffc };
const NO_PRINT: PdfSecurity = { revision: 6, permissions: 0xfffffffc & ~(1 << 2), userPermissions: 0xfffffff8 };

type FrameEvents = { load(): void; error(): void };

function harness(options: {
  open?: boolean;
  security?: PdfSecurity | null | "unreadable";
  exported?: PrintableResult | "throws" | (() => Promise<PrintableResult>);
  confirm?: boolean;
  printThrows?: boolean;
  windowOpens?: boolean;
  isCurrent?: () => boolean;
} = {}) {
  const clock = fakeClock();
  const log: string[] = [];
  const toasts: string[] = [];
  const confirms: string[] = [];
  let exports = 0;
  let frameEvents: FrameEvents | null = null;
  let afterPrint: (() => void) | null = null;
  const urls = new Set<string>();
  let title = "Shiori";
  const frame: PrintFrame = {
    print() {
      log.push("print");
      if (options.printThrows) throw new Error("blocked");
    },
    listenAfterPrint(run) {
      afterPrint = run;
      return () => {
        afterPrint = null;
      };
    },
    remove() {
      log.push("remove");
    },
  };
  const ports: PrintPorts = {
    document: () => (options.open === false ? null : { fileName: "paper.pdf" }),
    security: () => {
      if (options.security === "unreadable") throw new Error("no security");
      return options.security === undefined ? null : options.security;
    },
    exportForPrint: async () => {
      exports += 1;
      const exported = options.exported ?? { kind: "ready", bytes: new Uint8Array([1, 2]), lostChars: 0 };
      if (exported === "throws") throw new Error("export broke");
      return typeof exported === "function" ? exported() : exported;
    },
    isCurrent: options.isCurrent ?? (() => true),
    confirm: (message) => {
      confirms.push(message);
      return options.confirm ?? true;
    },
    toastError: (message) => toasts.push(message),
    t: (key, values) => (values ? `${key} ${JSON.stringify(values)}` : key),
    host: {
      createUrl: () => {
        const url = `blob:${urls.size + 1}`;
        urls.add(url);
        log.push(`url ${url}`);
        return url;
      },
      revokeUrl: (url) => {
        urls.delete(url);
        log.push(`revoke ${url}`);
      },
      mountFrame: (url, events) => {
        log.push(`mount ${url}`);
        frameEvents = events;
        return frame;
      },
      openWindow: (url) => {
        log.push(`window ${url}`);
        return options.windowOpens ?? true;
      },
      setTitle: (next) => {
        const previous = title;
        title = next;
        return () => {
          title = previous;
        };
      },
    },
    clock,
  };
  return {
    ports,
    clock,
    log,
    toasts,
    confirms,
    exports: () => exports,
    liveUrls: () => urls.size,
    title: () => title,
    load: () => frameEvents?.load(),
    fail: () => frameEvents?.error(),
    afterPrint: () => afterPrint?.(),
  };
}

const settle = () => Bun.sleep(0);

describe("runPrint", () => {
  test("hands the exported PDF to a frame titled after the file, and cleans up after printing", async () => {
    const h = harness();
    const run = runPrint(h.ports);
    await settle();
    expect(h.log).toEqual(["url blob:1", "mount blob:1"]);

    h.load();
    expect(h.log).toContain("print");
    expect(h.title()).toBe("paper.pdf");

    h.afterPrint();
    expect(await run).toEqual({ kind: "printed" });
    expect(h.log.slice(-2)).toEqual(["remove", "revoke blob:1"]);
    expect(h.liveUrls()).toBe(0);
    expect(h.title()).toBe("Shiori");
    expect(h.clock.pending()).toBe(0);
  });

  test("bounds the frame lifetime and cleans up when the document leaves", async () => {
    let current = true;
    const h = harness({ isCurrent: () => current });
    let settled = false;
    const run = runPrint(h.ports).then((outcome) => {
      settled = true;
      return outcome;
    });
    await settle();
    h.clock.advance(29_999);
    await settle();
    expect(settled).toBe(false);
    expect(h.liveUrls()).toBe(1);

    h.clock.advance(1);
    expect(h.liveUrls()).toBe(0);
    expect(await run).toEqual({ kind: "failed" });
    expect(h.log).toContain("remove");

    const next = runPrint(h.ports);
    await settle();
    h.load();
    current = false;
    h.clock.advance(100);
    expect(h.liveUrls()).toBe(0);
    expect(await next).toEqual({ kind: "superseded" });
  });

  test("a frame that fails to load is removed and its URL revoked", async () => {
    const h = harness();
    const run = runPrint(h.ports);
    await settle();
    h.fail();
    expect(await run).toEqual({ kind: "failed" });
    expect(h.log).not.toContain("print");
    expect(h.liveUrls()).toBe(0);
  });

  test("opens the PDF in a window when the browser refuses to print the frame", async () => {
    const h = harness({ printThrows: true });
    const run = runPrint(h.ports);
    await settle();
    h.load();
    expect(h.log).toContain("window blob:1");
    expect(h.toasts).toEqual([]);
    // The window reads the URL while it loads: it stays until the timeout.
    h.clock.advance(30_000);
    expect(await run).toEqual({ kind: "openedInWindow" });
    expect(h.liveUrls()).toBe(0);
  });

  test("says so when both the frame and the fallback window are blocked", async () => {
    const h = harness({ printThrows: true, windowOpens: false });
    const run = runPrint(h.ports);
    await settle();
    h.load();
    h.clock.advance(30_000);
    expect(await run).toEqual({ kind: "failed" });
    expect(h.toasts).toEqual(["toast.printFailed"]);
  });

  test("refuses before exporting when the opening password does not allow printing", async () => {
    const h = harness({ security: NO_PRINT });
    expect(await runPrint(h.ports)).toEqual({ kind: "refused", reason: "permission" });
    expect(h.exports()).toBe(0);
    expect(h.toasts).toEqual(["export.printPermissionError"]);
    expect(h.log).toEqual([]);
  });

  test("an encrypted file opened with a password that allows printing goes on to the export", async () => {
    const h = harness({ security: ALL });
    const run = runPrint(h.ports);
    await settle();
    expect(h.exports()).toBe(1);
    h.load();
    h.afterPrint();
    expect(await run).toEqual({ kind: "printed" });

    const blocked = harness({ security: ALL, printThrows: true });
    const failed = runPrint(blocked.ports);
    await settle();
    blocked.load();
    blocked.clock.advance(30_000);
    expect(await failed).toEqual({ kind: "failed" });
    expect(blocked.toasts).toEqual(["toast.printFailed"]);
    expect(blocked.log).not.toContain("window blob:1");
  });

  test("refuses before exporting, saying the security is unknown, when the engine cannot report it", async () => {
    const h = harness({ security: "unreadable" });
    expect(await runPrint(h.ports)).toEqual({ kind: "refused", reason: "securityUnknown" });
    expect(h.exports()).toBe(0);
    expect(h.toasts).toEqual(["export.printSecurityUnknownError"]);
  });

  test("names a signed source, in print terms, when the export refuses it", async () => {
    const h = harness({ exported: { kind: "refused", reason: "signed" } });
    expect(await runPrint(h.ports)).toEqual({ kind: "refused", reason: "signed" });
    expect(h.toasts).toEqual(["export.signedPrintError"]);
    expect(h.log).toEqual([]);
  });

  test("says the security is unknown when the export cannot read it", async () => {
    const h = harness({ exported: { kind: "refused", reason: "securityUnknown" } });
    expect(await runPrint(h.ports)).toEqual({ kind: "refused", reason: "securityUnknown" });
    expect(h.toasts).toEqual(["export.printSecurityUnknownError"]);
    expect(h.log).toEqual([]);
  });

  test("names the permission when the export refuses printing", async () => {
    const h = harness({ exported: { kind: "refused", reason: "permission" } });
    expect(await runPrint(h.ports)).toEqual({ kind: "refused", reason: "permission" });
    expect(h.toasts).toEqual(["export.printPermissionError"]);
    expect(h.log).toEqual([]);
  });

  test("an export that throws is reported as a print failure", async () => {
    const h = harness({ exported: "throws" });
    expect(await runPrint(h.ports)).toEqual({ kind: "failed" });
    expect(h.toasts).toEqual(["toast.printFailed"]);
    expect(h.log).toEqual([]);
  });

  test("asks before printing with characters the fonts cannot draw, and stops on cancel", async () => {
    const h = harness({
      exported: { kind: "ready", bytes: new Uint8Array([1]), lostChars: 3 },
      confirm: false,
    });
    expect(await runPrint(h.ports)).toEqual({ kind: "cancelled" });
    expect(h.confirms).toEqual(['export.lostCharsPrintConfirm {"count":3}']);
    expect(h.log).toEqual([]);
  });

  test("prints with lost characters once the reader agrees", async () => {
    const h = harness({
      exported: { kind: "ready", bytes: new Uint8Array([1]), lostChars: 3 },
      confirm: true,
    });
    const run = runPrint(h.ports);
    await settle();
    h.load();
    h.afterPrint();
    expect(await run).toEqual({ kind: "printed" });
  });

  test("does nothing when no document is open", async () => {
    const h = harness({ open: false });
    expect(await runPrint(h.ports)).toEqual({ kind: "cancelled" });
    expect(h.exports()).toBe(0);
    expect(h.toasts).toEqual([]);
  });

  test("a tab switch during the export leaves no URL and no frame", async () => {
    let current = true;
    let finishExport: (result: PrintableResult) => void = () => {};
    const h = harness({
      isCurrent: () => current,
      exported: () =>
        new Promise((resolve) => {
          finishExport = resolve;
        }),
    });
    const run = runPrint(h.ports);
    await settle();
    current = false;
    finishExport({ kind: "ready", bytes: new Uint8Array([1]), lostChars: 2 });
    expect(await run).toEqual({ kind: "superseded" });
    expect(h.confirms).toEqual([]);
    expect(h.log).toEqual([]);
  });

  test("a tab switch while the lost-characters prompt is open leaves no frame", async () => {
    let current = true;
    const h = harness({
      isCurrent: () => current,
      exported: { kind: "ready", bytes: new Uint8Array([1]), lostChars: 1 },
    });
    h.ports.confirm = () => {
      current = false;
      return true;
    };
    expect(await runPrint(h.ports)).toEqual({ kind: "superseded" });
    expect(h.log).toEqual([]);
  });

  test("a tab switch before the frame loads removes it without printing", async () => {
    let current = true;
    const h = harness({ isCurrent: () => current });
    const run = runPrint(h.ports);
    await settle();
    current = false;
    h.load();
    expect(await run).toEqual({ kind: "superseded" });
    expect(h.log).not.toContain("print");
    expect(h.log).toContain("remove");
    expect(h.liveUrls()).toBe(0);
    expect(h.title()).toBe("Shiori");
  });
});
