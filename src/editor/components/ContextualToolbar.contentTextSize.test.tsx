import "../../test/setupDom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import i18n from "../../i18n";
import type { ContentTextOverlay } from "../../pdf/model/types";
import { exportPdf } from "../../pdf/export/exportPdf";
import {
  fixture,
  model,
  overlay,
} from "../../pdf/export/contentText/fixtures.test-support";
import { openPdfium } from "../../../scripts/pdf-inplace/nativePdfium";
import { useEditorStore } from "../store/store";
import { ContextualToolbar } from "./ContextualToolbar";

// The size control on an editable source run must reach the saved PDF. The
// defect: the toolbar showed 15 while the export wrote the run at its source
// 10 pt and reported success. This drives the real toolbar field, then feeds
// the store's overlay through the production exporter and reads the saved
// glyphs back with PDFium. Only a committed text edit is covered here; a
// pristine size-only draft depends on the editor's draft/commit predicate.

const library = resolve(
  process.env.SHIORI_PDFIUM_DIR ?? "vendor/pdfium/linux-x64/lib",
  "libpdfium.so",
);
const loadFont = (name: string) =>
  readFile(
    name.startsWith("Noto")
      ? `src/assets/fonts/${name}`
      : `node_modules/@docx-editor.dev/fonts/assets/${name}`,
  );

let restoreResizeObserver: () => void = () => undefined;
function installResizeObserver(): () => void {
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return () => {
    if (previous === undefined) {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    } else {
      globalThis.ResizeObserver = previous;
    }
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  restoreResizeObserver = installResizeObserver();
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  restoreResizeObserver();
  act(() => {
    useEditorStore.setState({
      model: { pages: [], overlays: [] },
      undoStack: [],
      redoStack: [],
      selectedIds: [],
      tool: "select",
    } as never);
  });
});

function commitSize(container: HTMLElement, value: string): void {
  const label = i18n.t("inspector.fields.size");
  const open = Array.from(container.querySelectorAll<HTMLElement>("button")).find(
    (b) => b.getAttribute("aria-label")?.startsWith(`${label}:`),
  );
  if (!open) throw new Error("no size value button in the toolbar");
  act(() => {
    fireEvent.click(open);
  });
  const field = container.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!field) throw new Error("the size field did not open");
  act(() => {
    fireEvent.change(field, { target: { value } });
    fireEvent.keyDown(field, { key: "Enter" });
  });
}

describe("content text size from the toolbar", () => {
  test.skipIf(!existsSync(library))(
    "AXCDE set to 15 pt in the toolbar saves 15 pt glyphs; a second run stays 10 pt",
    async () => {
      const source = await fixture(
        "BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET BT /F1 10 Tf 50 40 Td (KEEP) Tj ET",
      );
      const before = await source.doc.save();
      const edit = overlay({ text: "AXCDE" });
      const doc = model([edit]);
      act(() => {
        useEditorStore.setState({
          model: doc,
          undoStack: [],
          redoStack: [],
          selectedIds: [edit.id],
          tool: "select",
        } as never);
      });
      const view = render(<ContextualToolbar />);
      commitSize(view.container, "15");

      const edited = useEditorStore
        .getState()
        .model.overlays.find((o) => o.id === edit.id) as ContentTextOverlay;
      expect(edited.fontSize).toBe(15);
      expect(edited.sourceStyle?.fontSize).toBe(10);

      const result = await exportPdf(
        before,
        useEditorStore.getState().model,
        { mode: "annotations", inPlaceFallback: { loadFont } },
      );
      expect(result.contentTextOutcomes?.[0]?.mode).toBe("retypeset");
      const native = openPdfium(library);
      try {
        const glyphs = native
          .inspectPage(result.bytes, 0)
          .glyphs.filter((g) => g.text.trim())
          .map((g) => [g.text, +g.fontSize.toFixed(2), +g.origin[1].toFixed(2)]);
        expect(glyphs).toEqual([
          ["A", 15, 100],
          ["X", 15, 100],
          ["C", 15, 100],
          ["D", 15, 100],
          ["E", 15, 100],
          ["K", 10, 40],
          ["E", 10, 40],
          ["E", 10, 40],
          ["P", 10, 40],
        ]);
      } finally {
        native.close();
      }
    },
  );
});
