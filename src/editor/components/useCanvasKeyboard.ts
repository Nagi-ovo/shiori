import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";
import {
  useAppStore,
  useEditorStore,
  type PdfEditorStoreApi,
} from "../store/store";
import { rotatedSize } from "../../pdf/geometry/coords";
import { toast } from "../toast";
import { finishCreationDrag } from "./overlays/overlayCreation";
import {
  RECT_KEYBOARD_HEIGHT_PT,
  RECT_KEYBOARD_WIDTH_PT,
} from "./overlays/overlayConstants";
import { requestPrint } from "../viewport/requestPrint";
import { zoomStepDown, zoomStepUp } from "../viewport/zoomCommands";
import {
  arrowDelta,
  resolveCanvasKey,
  type CanvasCommand,
} from "../viewport/canvasKeymap";

/**
 * The PDF canvas's window keyboard: runs the commands canvasKeymap resolves,
 * including Space-to-pan, whose state lives in Canvas.
 */
export function useCanvasKeyboard({
  editorStore,
  setSpacePan,
  setPanning,
  panRef,
}: {
  editorStore: PdfEditorStoreApi;
  setSpacePan: (on: boolean) => void;
  setPanning: (on: boolean) => void;
  panRef: { current: unknown };
}): void {
  const { t } = useTranslation();
  const removeSelected = useEditorStore((s) => s.removeSelected);
  const duplicateSelected = useEditorStore((s) => s.duplicateSelected);
  const copySelected = useEditorStore((s) => s.copySelected);
  const pasteClipboard = useEditorStore((s) => s.pasteClipboard);
  const nudgeSelected = useEditorStore((s) => s.nudgeSelected);
  const nudgeSelectedNoHistory = useEditorStore((s) => s.nudgeSelectedNoHistory);
  const beginHistoryStep = useEditorStore((s) => s.beginHistoryStep);
  const selectAllOnPage = useEditorStore((s) => s.selectAllOnPage);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const setTool = useEditorStore((s) => s.setTool);
  const setAnnotDefaults = useAppStore((s) => s.setAnnotDefaults);
  const setShowShortcuts = useAppStore((s) => s.setShowShortcuts);
  const setShowFind = useAppStore((s) => s.setShowFind);
  const setShowExport = useAppStore((s) => s.setShowExport);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setShowGoToPage = useAppStore((s) => s.setShowGoToPage);
  const setScale = useEditorStore((s) => s.setScale);
  const setFitMode = useEditorStore((s) => s.setFitMode);
  // True while an arrow key is held for nudging, so the auto-repeat stream
  // collapses into the single history step pushed on the first keydown.
  const arrowNudgeHeldRef = useRef(false);
  // The control that last took focus from a pointer press rather than the
  // keyboard. Chromium focuses a button on click (macOS WebKit does not);
  // such a button leaves Space and Enter to the canvas (resolveCanvasKey).
  const pointerFocusedRef = useRef<EventTarget | null>(null);
  useEffect(() => {
    let lastInputWasPointer = false;
    const onPointerDown = () => {
      lastInputWasPointer = true;
    };
    const onKeyDown = () => {
      lastInputWasPointer = false;
    };
    const onFocusIn = (e: FocusEvent) => {
      pointerFocusedRef.current = lastInputWasPointer ? e.target : null;
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, []);

  // Place the armed tool at the centre of the active page, without a pointer.
  // A zero-extent drag is deliberate: finishCreationDrag routes anything below
  // the minimum size through the same path a tap takes, which is where each
  // tool's default dimensions already live. So this reuses the exact geometry,
  // defaults and overlay construction the mouse path uses — no second
  // definition of "what a new note looks like" to drift out of sync.
  //
  // Returns whether it placed anything, so the caller only swallows the key
  // when something actually happened.
  const placeArmedToolAtPageCentre = useCallback((): boolean => {
    const state = editorStore.getState();
    const appState = useAppStore.getState();
    const kind = state.tool;
    // `ink` is a freehand path with no meaningful default shape, and area
    // `highlight` has a better keyboard route already: select text, then use
    // the selection popup. Everything else places a default-sized overlay.
    if (
      kind !== "rect" &&
      kind !== "note" &&
      kind !== "text" &&
      kind !== "stamp" &&
      kind !== "signature"
    ) {
      return false;
    }
    if (kind === "signature" && !appState.activeSignature) return false;
    const page = state.model.pages.find((p) => p.id === state.activePageId);
    if (!page) return false;

    const size = rotatedSize(page.widthPt, page.heightPt, page.rotation);
    const centreX = (size.width * state.scale) / 2;
    const centreY = (size.height * state.scale) / 2;
    // Note, text, stamp and signature all define a tap size, so a zero-extent
    // drag is enough. Rectangle deliberately yields nothing on a tap — a stray
    // click must not leave a stray box — so keyboard placement supplies its
    // own extent from the one constant that owns that decision.
    const halfW =
      kind === "rect" ? (RECT_KEYBOARD_WIDTH_PT * state.scale) / 2 : 0;
    const halfH =
      kind === "rect" ? (RECT_KEYBOARD_HEIGHT_PT * state.scale) / 2 : 0;
    const creation = finishCreationDrag({
      drag: {
        kind,
        startX: centreX - halfW,
        startY: centreY - halfH,
        curX: centreX + halfW,
        curY: centreY + halfH,
      },
      page,
      scale: state.scale,
      annotDefaults: appState.annotDefaults,
      textDefaults: state.textDefaults,
      activeSignature: appState.activeSignature,
      makeId: nanoid,
    });
    if (creation.kind !== "overlay") return false;

    state.addOverlay(creation.overlay);
    // Selected on arrival, so the existing arrow-key nudge takes over as the
    // positioning step: arm, Enter, then arrows. Text-bearing types open for
    // editing the same way a tap does.
    state.selectOnly(creation.overlay.id);
    if (creation.edit) state.setEditingOverlayId(creation.overlay.id);
    toast.showAction(t("toast.placedAnnotation"), {
      label: t("toast.undo"),
      onClick: () => undo(),
    });
    return true;
    // Everything else is read through editorStore.getState() at call time, so
    // this stays stable across the store updates it causes.
  }, [editorStore, t, undo]);

  useEffect(() => {
    // Applies a command; false when the document's state made it a no-op,
    // so the key keeps its default.
    const run = (command: CanvasCommand): boolean => {
      const state = editorStore.getState();
      switch (command.type) {
        case "spacePan":
          if (!command.repeat) setSpacePan(true);
          return true;
        case "undo":
          undo();
          return true;
        case "redo":
          redo();
          return true;
        case "copy": {
          const count = state.selectedIds.length;
          if (count === 0) return false;
          copySelected();
          toast.show(t("toast.copiedAnnotations", { count }));
          return true;
        }
        case "paste": {
          const { activePageId: pageId, overlayClipboard, model } = state;
          if (overlayClipboard.length === 0 || !pageId) return false;
          pasteClipboard(pageId);
          const pageNumber = model.pages.findIndex((p) => p.id === pageId) + 1;
          toast.showAction(
            t("toast.pastedAnnotations", {
              count: overlayClipboard.length,
              page: pageNumber,
            }),
            { label: t("toast.undo"), onClick: () => undo() },
          );
          return true;
        }
        case "duplicate": {
          const count = state.selectedIds.length;
          duplicateSelected();
          if (count > 0) {
            toast.showAction(
              t("toast.duplicatedAnnotations", { count }),
              { label: t("toast.undo"), onClick: () => undo() },
            );
          }
          return true;
        }
        case "selectAllOnPage":
          if (isPdfTextSelectionContext()) return false;
          selectAllOnPage(state.activePageId);
          return true;
        case "goToPageDialog":
          setShowGoToPage(true);
          return true;
        case "print":
          void requestPrint(editorStore);
          return true;
        case "find":
          setShowFind(true);
          return true;
        case "zoom":
          setScale(
            command.direction === "in"
              ? zoomStepUp(state.scale)
              : zoomStepDown(state.scale),
          );
          return true;
        case "fitWidth":
          setFitMode("width");
          return true;
        case "actualSize":
          setScale(1);
          return true;
        case "nudge":
          if (state.selectedIds.length === 0) return false;
          // One history step per key HOLD, not per auto-repeat, mirroring how
          // a pointer drag is a single undo step for the whole gesture. The
          // latch is cleared on keyup below.
          if (!command.repeat && !arrowNudgeHeldRef.current) {
            arrowNudgeHeldRef.current = true;
            beginHistoryStep();
          }
          nudgeSelectedNoHistory(command.dx, command.dy);
          return true;
        case "delete": {
          const { selectedIds, model } = state;
          const count = model.overlays.filter(
            (o) => selectedIds.includes(o.id) && !o.locked,
          ).length;
          removeSelected();
          if (count > 0) {
            toast.showAction(
              t("toast.removedAnnotations", { count }),
              { label: t("toast.undo"), onClick: () => undo() },
            );
          }
          // Delete never claimed the key.
          return false;
        }
        case "placeArmedTool":
          // Putting an annotation down was the one step of the whole flow
          // with no keyboard path: arming, moving and deleting all had keys,
          // but creating an overlay sat behind pointerdown→pointerup.
          return placeArmedToolAtPageCentre();
        case "shortcuts":
          setShowShortcuts(true);
          return true;
        case "escape":
          // Esc returns to the select tool (a dialog's own Esc closes it;
          // keys never reach here while one is open, see onKey).
          if (state.tool === "select") return false;
          setTool("select");
          return true;
        case "tool":
          if (
            command.tool === "highlight" ||
            command.tool === "underline" ||
            command.tool === "strikethrough"
          ) {
            setAnnotDefaults({ textMarkupTool: command.tool });
          }
          setTool(command.tool);
          // Tool letters never claimed the key.
          return false;
        case "page":
          moveActivePage(editorStore, command.delta);
          return false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      // A dialog over the canvas owns the keyboard. Its keys still bubble
      // to this window listener, and with its panel (not a field) focused
      // a letter switched the tool behind it, J turned the page and Delete
      // removed the selected annotation.
      if (document.querySelector('[aria-modal="true"], [data-shiori-modal-open]')) return;
      // A focused widget that handled the key has claimed it: the thumbnail
      // rail pages on arrows, the tab strip walks its tabs, the navigator's
      // resize handle resizes. Acting on it too nudged the selection.
      if (e.defaultPrevented) return;
      const command = resolveCanvasKey({
        key: e.key,
        code: e.code,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        repeat: e.repeat,
        target: e.target instanceof HTMLElement ? e.target : null,
        targetFocusedByPointer: e.target === pointerFocusedRef.current,
      });
      if (command && run(command)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (arrowDelta(e.key)) arrowNudgeHeldRef.current = false;
      if (e.code !== "Space") return;
      setSpacePan(false);
      setPanning(false);
      panRef.current = null;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    editorStore,
    undo,
    redo,
    copySelected,
    pasteClipboard,
    nudgeSelected,
    nudgeSelectedNoHistory,
    beginHistoryStep,
    duplicateSelected,
    selectAllOnPage,
    removeSelected,
    setTool,
    setAnnotDefaults,
    setShowShortcuts,
    setShowFind,
    setShowExport,
    setShowSettings,
    setShowGoToPage,
    setScale,
    setFitMode,
    t,
    placeArmedToolAtPageCentre,
    setSpacePan,
    setPanning,
    panRef,
  ]);
}

export function isPdfTextSelectionContext(): boolean {
  const active = document.activeElement;
  if (active instanceof Element && active.closest(".shioriTextLayer")) {
    return true;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }
  for (let i = 0; i < selection.rangeCount; i += 1) {
    if (nodeClosest(selection.getRangeAt(i).commonAncestorContainer, ".shioriTextLayer")) {
      return true;
    }
  }
  return false;
}

function nodeClosest(node: Node, selector: string): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(selector) ?? null;
}

function moveActivePage(editorStore: PdfEditorStoreApi, delta: -1 | 1) {
  const { model, activePageId, goToPage } = editorStore.getState();
  const current = model.pages.findIndex((p) => p.id === activePageId);
  if (current < 0) return;
  const index = Math.max(0, Math.min(model.pages.length - 1, current + delta));
  const next = model.pages[index];
  if (next && next.id !== activePageId) goToPage(next.id, index);
}
