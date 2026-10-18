import { detectDocumentKind } from "../../documents/types";
import { assertPdfWithinFileLimit } from "../../pdf/openPolicy";
import type { BoundPageMerge, PageMergeRequest } from "./pageMerge";

/** How long an insert runs before it shows as busy; shorter ones never flash. */
export const MERGE_BUSY_DELAY_MS = 180;

export type MergePickerNotice =
  | { kind: "notPdf"; name: string }
  /** The picker itself failed. */
  | { kind: "pickFailed"; error: unknown }
  /** The picked file could not be read or inserted. */
  | { kind: "insertFailed"; error: unknown; name: string; size: number };

type PickedPdf = { bytes: Uint8Array; name: string };

export type MergePickerPorts = {
  /** Binds a merge to the document on screen now (createPageMerges().begin). */
  begin: (request: PageMergeRequest) => BoundPageMerge;
  /** The last page of the document on screen, where "insert" defaults to. */
  lastPageId: () => string | null;
  /** The native (desktop or mobile) PDF picker, or null where there is none. */
  pickNative: (() => Promise<PickedPdf | null>) | null;
  /** The File System Access picker, or null where the browser lacks it. */
  pickWeb: (() => Promise<PickedPdf | null>) | null;
  /** Opens the hidden `<input type=file>`; its file comes back to `fromInput`. */
  clickInput: () => void;
  timers: { set: (run: () => void, ms: number) => number; clear: (handle: number) => void };
  setBusy: (busy: boolean) => void;
  notify: (notice: MergePickerNotice) => void;
};

/**
 * Inserting another PDF's pages after a chosen page, from whichever picker
 * the platform has. The merge is bound to the document and page before the
 * picker opens: the reader may switch tabs or reorder pages while it is up,
 * and the insert must land where it was asked for or not at all.
 */
export function createMergePicker(ports: MergePickerPorts) {
  let inFlight = false;
  let awaitingInput: BoundPageMerge | null = null;

  async function withFeedback(task: () => Promise<boolean>): Promise<boolean> {
    if (inFlight) return false;
    inFlight = true;
    const busy = ports.timers.set(() => ports.setBusy(true), MERGE_BUSY_DELAY_MS);
    try {
      return await task();
    } finally {
      ports.timers.clear(busy);
      inFlight = false;
      ports.setBusy(false);
    }
  }

  return {
    async pick(afterPageId: string | null): Promise<void> {
      if (inFlight) return;
      const pageId = afterPageId ?? ports.lastPageId();
      if (!pageId) return;
      const insert = ports.begin({
        placement: { kind: "after", pageId },
        keepBaseFileName: true,
        announcePdfInsertion: true,
      });
      try {
        const picker = ports.pickNative ?? ports.pickWeb;
        if (picker) {
          const picked = await picker();
          if (picked) await withFeedback(() => insert(picked.bytes, picked.name));
          return;
        }
        awaitingInput = insert;
        ports.clickInput();
      } catch (error) {
        ports.notify({ kind: "pickFailed", error });
      }
    },

    /** The file the hidden input returned for the last `pick`. */
    fromInput(file: File | undefined): void {
      const insert = awaitingInput;
      awaitingInput = null;
      if (!file || !insert) return;
      void withFeedback(async () => {
        if (detectDocumentKind(file.name) !== "pdf") {
          ports.notify({ kind: "notPdf", name: file.name });
          return false;
        }
        assertPdfWithinFileLimit(file.size);
        return insert(new Uint8Array(await file.arrayBuffer()), file.name);
      }).catch((error) => {
        ports.notify({ kind: "insertFailed", error, name: file.name, size: file.size });
      });
    },
  };
}

export type MergePicker = ReturnType<typeof createMergePicker>;
