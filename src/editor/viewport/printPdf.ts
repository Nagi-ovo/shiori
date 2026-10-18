import type { PdfSecurity } from "../../pdf/engine/types";
import type { PrintableResult, PrintRefusal } from "../../pdf/export/printablePdf";
import { mayPrint } from "../../pdf/security/permissions";
import type { Clock, TimerHandle } from "./clock";

/** How a print request ended. */
export type PrintOutcome =
  | { kind: "printed" }
  | { kind: "openedInWindow" }
  | { kind: "refused"; reason: PrintRefusal }
  | { kind: "cancelled" }
  /** The document left the screen before anything printed. */
  | { kind: "superseded" }
  | { kind: "failed" };

/** A hidden frame holding the print copy. */
export type PrintFrame = {
  /** Opens the print dialog for the frame; throws when the browser refuses. */
  print(): void;
  /** Runs `run` on afterprint from the window or the frame; returns the unsubscribe. */
  listenAfterPrint(run: () => void): () => void;
  remove(): void;
};

export type PrintPorts = {
  /** The document on screen, or null when none is open. */
  document: () => { fileName: string } | null;
  /** The opening password's security; throws when the engine cannot report it. */
  security: () => PdfSecurity | null;
  /** Builds the print copy (lazy: the export code loads on first print). */
  exportForPrint: () => Promise<PrintableResult>;
  /** Whether the document the run started for is still the one on screen. */
  isCurrent: () => boolean;
  confirm: (message: string) => boolean;
  toastError: (message: string) => void;
  t: (key: string, values?: Record<string, unknown>) => string;
  host: {
    createUrl: (bytes: Uint8Array) => string;
    revokeUrl: (url: string) => void;
    mountFrame: (url: string, events: { load(): void; error(): void }) => PrintFrame;
    /** Opens the URL in a new window; false when a popup blocker stopped it. */
    openWindow: (url: string) => boolean;
    /** Sets the window title and returns how to restore it. */
    setTitle: (title: string) => () => void;
  };
  clock: Clock;
};

/**
 * How long a print frame may stay mounted when afterprint never comes (some
 * viewers never fire it, a fallback window never can): far beyond the time
 * the frame needs to hand its pages to the print dialog.
 */
export const PRINT_CLEANUP_MS = 30_000;

/**
 * One print request, from the permission check to the frame's cleanup. The
 * returned promise settles once the frame is gone and its blob URL revoked,
 * so a caller's busy indicator covers the whole time the print dialog may be
 * up.
 */
export async function runPrint(ports: PrintPorts): Promise<PrintOutcome> {
  const { t } = ports;
  const document = ports.document();
  if (!document) return { kind: "cancelled" };

  // The password that opened the file must allow printing (bit 3); security
  // the engine could not report refuses too, and says so.
  let printable: boolean;
  let encrypted: boolean;
  try {
    const security = ports.security();
    encrypted = security !== null;
    printable = mayPrint(security);
  } catch {
    return refuse(ports, "securityUnknown");
  }
  if (!printable) return refuse(ports, "permission");

  let exported: PrintableResult;
  try {
    exported = await ports.exportForPrint();
  } catch {
    ports.toastError(t("toast.printFailed"));
    return { kind: "failed" };
  }
  if (exported.kind === "refused") return refuse(ports, exported.reason);
  if (!ports.isCurrent()) return { kind: "superseded" };
  if (
    exported.lostChars > 0 &&
    !ports.confirm(t("export.lostCharsPrintConfirm", { count: exported.lostChars }))
  ) {
    return { kind: "cancelled" };
  }
  if (!ports.isCurrent()) return { kind: "superseded" };
  return printInFrame(ports, document.fileName, exported.bytes, encrypted);
}

function refuse(ports: PrintPorts, reason: PrintRefusal): PrintOutcome {
  const { t } = ports;
  switch (reason) {
    case "permission":
      ports.toastError(t("export.printPermissionError"));
      break;
    case "securityUnknown":
      ports.toastError(t("export.printSecurityUnknownError"));
      break;
    case "signed":
      ports.toastError(t("export.signedPrintError"));
      break;
  }
  return { kind: "refused", reason };
}

function printInFrame(
  ports: PrintPorts,
  fileName: string,
  bytes: Uint8Array,
  encrypted: boolean,
): Promise<PrintOutcome> {
  const { host, clock, t } = ports;
  return new Promise((resolve) => {
    const url = host.createUrl(bytes);
    let done = false;
    let loaded = false;
    let outcome: PrintOutcome = { kind: "failed" };
    const deadline = clock.now() + PRINT_CLEANUP_MS;
    let timer: TimerHandle | null = null;
    let restoreTitle: (() => void) | null = null;
    let stopListening: (() => void) | null = null;
    const finish = (outcome: PrintOutcome) => {
      if (done) return;
      done = true;
      if (timer !== null) clock.clearTimeout(timer);
      stopListening?.();
      restoreTitle?.();
      frame.remove();
      host.revokeUrl(url);
      resolve(outcome);
    };
    const frame = host.mountFrame(url, {
      load: () => {
        if (done || loaded) return;
        loaded = true;
        if (!ports.isCurrent()) return finish({ kind: "superseded" });
        restoreTitle = host.setTitle(fileName);
        outcome = { kind: "printed" };
        stopListening = frame.listenAfterPrint(() => finish(outcome));
        try {
          frame.print();
        } catch {
          // Popup blockers refuse print() on the frame; the reader must hear
          // something either way — print was the one export-family action
          // that could fail with no feedback at all.
          if (!encrypted && host.openWindow(url)) {
            outcome = { kind: "openedInWindow" };
          } else {
            ports.toastError(t("toast.printFailed"));
            outcome = { kind: "failed" };
          }
        }
      },
      error: () => finish({ kind: "failed" }),
    });
    const checkLifetime = () => {
      if (!ports.isCurrent()) return finish({ kind: "superseded" });
      if (clock.now() >= deadline) return finish(outcome);
      timer = clock.setTimeout(checkLifetime, Math.min(100, deadline - clock.now()));
    };
    checkLifetime();
  });
}
