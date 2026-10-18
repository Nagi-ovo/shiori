import { isPdfTextSelectionContext } from "../editor/components/Canvas";
import {
  MARKDOWN_EDITOR_COMMAND_EVENT,
  type MarkdownEditorCommand,
} from "../editor/components/markdownLiveEditorCommands";
import type { PdfEditorStoreApi } from "../editor/store/store";
import { zoomStepDown, zoomStepUp } from "../editor/viewport/zoomCommands";
import { NATIVE_APP_EXIT_REQUEST_EVENT } from "../platform/appExit";
import { safeUnlisten } from "../platform/ipc";


export type NativeMenuPorts = {
  /** Subscribes to a channel the Rust side emits; resolves to its disposer. */
  listen: (channel: string, run: () => void) => Promise<() => unknown>;
  /** Tells Rust whether an exit request can currently reach the guard. */
  setExitGuardReady: (ready: boolean) => Promise<void>;
  /** The editor on screen when an item fires, not when the menu was wired. */
  activeEditor: () => PdfEditorStoreApi;
  completeExitRequest: () => void;
  checkForUpdates: () => void;
  openSettings: () => void;
  print: () => void;
  copiedAnnotations: (count: number) => void;
  installFailed: (error: unknown) => void;
};

function inTextEditor(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
  );
}

function inMarkdownLiveEditor(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el?.closest("[data-shiori-markdown-live-editor='true']");
}

function runMarkdownLiveEditorCommand(command: MarkdownEditorCommand): void {
  window.dispatchEvent(
    new CustomEvent<MarkdownEditorCommand>(MARKDOWN_EDITOR_COMMAND_EVENT, {
      detail: command,
    }),
  );
}

/**
 * The macOS menu bar, wired back into the app. The menu itself is built in
 * `src-tauri/src/lib.rs`; each item emits a channel, and here each channel
 * runs the same action the in-app shortcut would.
 *
 * The exit request is on this menu too: Rust holds ⌘Q until the frontend says
 * its guard is listening, so the guard is reported ready only once that
 * channel is subscribed, and not ready again as soon as it is torn down.
 */
export function createNativeMenu(ports: NativeMenuPorts) {
  const editor = () => ports.activeEditor().getState();

  return {
    /** Wires every item; the returned disposer may run before wiring ends. */
    install(): () => void {
      let active = true;
      const unlistens: Array<() => unknown> = [];
      const wire = async (channel: string, run: () => void) => {
        const off = await ports.listen(channel, run);
        if (active) unlistens.push(off);
        else safeUnlisten(off);
      };

      void (async () => {
        await wire("menu:check-for-updates", ports.checkForUpdates);
        await wire("menu:settings", ports.openSettings);
        await wire(NATIVE_APP_EXIT_REQUEST_EVENT, ports.completeExitRequest);
        if (active) await ports.setExitGuardReady(true);
        // Undo/Redo are custom menu items (see lib.rs): the predefined ones
        // swallow ⌘Z/⇧⌘Z before the webview and only ever drive native text
        // undo. With a text field focused we still want that native behavior,
        // so route back via execCommand; otherwise hit the document undo stack
        // like the Canvas keyboard handler does.
        await wire("menu:undo", () => {
          if (inMarkdownLiveEditor()) return runMarkdownLiveEditorCommand("undo");
          if (inTextEditor()) return void document.execCommand("undo");
          editor().undo();
        });
        await wire("menu:redo", () => {
          if (inMarkdownLiveEditor()) return runMarkdownLiveEditorCommand("redo");
          if (inTextEditor()) return void document.execCommand("redo");
          editor().redo();
        });
        // Copy and Select All are custom menu items (see lib.rs): the
        // predefined ones claimed ⌘C/⌘A natively and hid them from the
        // webview, so annotation copy/select-all were unreachable from the
        // keyboard on macOS. Mirror the Canvas keydown handler: act on the
        // document only when no text-editing context is active; otherwise fall
        // back to the native text behavior via execCommand. Paste stays
        // predefined so text inputs receive the native event; useAppShortcuts
        // handles that event for annotation/image paste outside editable
        // fields, so there is intentionally no menu:paste.
        await wire("menu:copy", () => {
          // With PDF text selected this fires the text layer's semantic-copy
          // handler; in an input or textarea it copies that selection.
          if (inTextEditor() || isPdfTextSelectionContext()) {
            return void document.execCommand("copy");
          }
          const count = editor().selectedIds.length;
          if (count === 0) return void document.execCommand("copy");
          editor().copySelected();
          ports.copiedAnnotations(count);
        });
        await wire("menu:select-all", () => {
          if (inMarkdownLiveEditor()) return runMarkdownLiveEditorCommand("selectAll");
          if (inTextEditor() || isPdfTextSelectionContext()) {
            return void document.execCommand("selectAll");
          }
          const state = editor();
          state.selectAllOnPage(state.activePageId);
        });
        await wire("menu:zoom-in", () => {
          const state = editor();
          state.setScale(zoomStepUp(state.scale));
        });
        await wire("menu:zoom-out", () => {
          const state = editor();
          state.setScale(zoomStepDown(state.scale));
        });
        await wire("menu:actual-size", () => editor().setScale(1));
        await wire("menu:fit-width", () => editor().setFitMode("width"));
        await wire("menu:print", ports.print);
      })().catch(ports.installFailed);

      return () => {
        active = false;
        void ports.setExitGuardReady(false).catch(() => undefined);
        // One listener failing to detach must not skip the rest of them.
        for (const off of unlistens) safeUnlisten(off);
      };
    },
  };
}
