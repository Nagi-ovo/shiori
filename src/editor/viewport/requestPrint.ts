import i18n from "../../i18n";
import { appPdfEngine } from "../../pdf/engine/appEngine";
import {
  activePdfEditorStore,
  useAppStore,
  type PdfEditorStoreApi,
} from "../store/store";
import { toast } from "../toast";
import { systemClock } from "./clock";
import { runPrint, type PrintFrame, type PrintOutcome, type PrintPorts } from "./printPdf";

/**
 * Prints the document open in `editor`. One print at a time: a request while
 * one runs is dropped. `isPrinting` is only the busy indicator (RightRail
 * hides the native browser panel while it is on, so the print dialog is not
 * drawn under it); nothing watches it to start work.
 */
export async function requestPrint(editor: PdfEditorStoreApi): Promise<PrintOutcome> {
  const app = useAppStore.getState();
  if (app.isPrinting) return { kind: "cancelled" };
  app.setIsPrinting(true);
  try {
    return await runPrint(printPorts(editor));
  } finally {
    useAppStore.getState().setIsPrinting(false);
  }
}

function printPorts(editor: PdfEditorStoreApi): PrintPorts {
  const opened = editor.getState().opened;
  const scroller = document.querySelector("[data-shiori-pdf-scroller]");
  return {
    document: () => (opened ? { fileName: opened.fileName } : null),
    security: () => (opened ? appPdfEngine.security(opened.doc) : null),
    exportForPrint: async () => {
      if (!opened) throw new Error("no document to print");
      const [{ exportPrintablePdf }, { cjkScExportFontUrl, cjkJpExportFontUrl }] =
        await Promise.all([
          import("../../pdf/export/printablePdf"),
          import("../../pdf/export/fontAssets"),
        ]);
      // An encrypted file prints from the engine's plaintext: the bytes go
      // only into the print frame's blob URL, revoked once printing ends.
      return exportPrintablePdf(appPdfEngine, opened, editor.getState().model, {
        unicodeFontUrl: cjkScExportFontUrl,
        unicodeJpFontUrl: cjkJpExportFontUrl,
      });
    },
    isCurrent: () =>
      (scroller?.isConnected ?? true) &&
      activePdfEditorStore() === editor && editor.getState().opened === opened,
    confirm: (message) => window.confirm(message),
    toastError: (message) => toast.error(message),
    t: (key, values) => i18n.t(key, values) as string,
    host: domPrintHost,
    clock: systemClock,
  };
}

const domPrintHost: PrintPorts["host"] = {
  createUrl: (bytes) =>
    URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" })),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  mountFrame: (url, events) => {
    const iframe = document.createElement("iframe");
    iframe.style.cssText =
      "position:fixed;width:0;height:0;border:none;opacity:0;pointer-events:none;";
    iframe.src = url;
    iframe.onload = () => events.load();
    iframe.onerror = () => events.error();
    document.body.appendChild(iframe);
    const frame: PrintFrame = {
      print: () => {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      },
      listenAfterPrint: (run) => {
        const frameWindow = iframe.contentWindow;
        window.addEventListener("afterprint", run, { once: true });
        frameWindow?.addEventListener("afterprint", run, { once: true });
        return () => {
          window.removeEventListener("afterprint", run);
          frameWindow?.removeEventListener("afterprint", run);
        };
      },
      remove: () => {
        iframe.parentNode?.removeChild(iframe);
      },
    };
    return frame;
  },
  openWindow: (url) => Boolean(window.open(url)),
  setTitle: (title) => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  },
};
