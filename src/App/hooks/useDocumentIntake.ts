import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";

import type { LoadedDocumentPayload } from "../../documents/types";
import { toast } from "../../editor/toast";
import { useAppStore } from "../../editor/store/store";
import {
  CAPABILITIES,
  classifyOpenTargetFromPlatform,
  listenWebPanelNav,
  listenWebPanelOpenRequest,
  readDocumentBytesFromPlatformPath,
  readMobileDocumentFromPlatformUrl,
  type MobileDocumentReference,
} from "../../platform";
import { safeUnlisten } from "../../platform/ipc";
import {
  listenNativeDocumentDrops,
  listenNativeEvent,
} from "../../platform/nativeEvents";
import { OpenHandoffQueue } from "../../platform/openHandoff";
import { showPlatformOpenError, unsupportedDocumentDetail } from "../openErrors";

const DESKTOP_OPEN_DEDUPE_MS = 1000;
const MOBILE_OPEN_DEDUPE_MS = 1500;

function isMobileDocumentReference(
  value: unknown,
): value is MobileDocumentReference {
  if (typeof value === "string") return value.length > 0;
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.uri === "string" && ref.uri.length > 0;
}

function mobileDocumentReferenceUri(ref: MobileDocumentReference): string {
  return typeof ref === "string" ? ref : ref.uri;
}

function mobileDocumentReferenceLabel(ref: MobileDocumentReference): string {
  if (typeof ref === "string") return ref;
  return typeof ref.name === "string" && ref.name.trim() ? ref.name : ref.uri;
}

function parseMobileDocumentReferences(
  // A thunk, not a string: the Android bridge call that produces the raw
  // JSON crosses the WebView JavaBridge boundary and can itself throw, so it
  // has to run inside this try/catch.
  readRaw: () => string,
): MobileDocumentReference[] {
  try {
    const parsed = JSON.parse(readRaw()) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.filter(isMobileDocumentReference);
  } catch {
    return [];
  }
}

interface DocumentIntakeParams {
  handleDocumentPayload: (payload: LoadedDocumentPayload) => Promise<unknown>;
  handleFile: (file: File) => Promise<unknown>;
  handleFolderPath: (path: string) => Promise<unknown> | unknown;
  setNativeExpired: Dispatch<SetStateAction<boolean>>;
}

/**
 * Platform document-intake listeners: every route
 * by which a document enters the app from outside the in-app picker — native
 * (Tauri) drag-drop, web drag-drop, the macOS Finder file-association queue,
 * the iOS/Android share/open queue, and the embedded browser panel's nav/open
 * events. Moved verbatim from the App God-component.
 *
 * The open pipeline itself (handleDocumentPayload / handleFile) stays in App —
 * it is entangled with tab state — and is passed in, so this hook is purely
 * "listen for an incoming document, then hand it to the pipeline". pickFile
 * and its ref bridge also stay in App (they depend on document-kind gating).
 *
 * Platform coverage note (AGENTS.md fact #9): only the desktop routes
 * (nativeDragDrop, nativePaths) can be exercised from a dev build here; the
 * mobile share/open and Android bridge routes are verbatim moves that still
 * warrant an on-device smoke test.
 */
/**
 * Every native listener here is installed from a floating async IIFE. A
 * rejection inside one — the plugin module failing to import, the webview
 * refusing the registration — used to go nowhere: no handler, no log, and the
 * route (drag-drop, file association, share sheet) was simply dead for the
 * session with nothing on screen or in the console saying why. Name the route
 * so a bug report has something to stand on.
 */
function reportNativeRouteFailure(route: string, err: unknown): void {
  console.error(`[shiori] native ${route} listener failed to install`, err);
}

export function useDocumentIntake({
  handleDocumentPayload,
  handleFile,
  handleFolderPath,
  setNativeExpired,
}: DocumentIntakeParams): { openPlatformPath: (path: string) => Promise<void> } {
  const { t } = useTranslation();
  const openPlatformPathRef = useRef<(path: string) => Promise<void>>(
    async () => undefined,
  );
  const handleDocumentPayloadRef = useRef(handleDocumentPayload);
  const translateRef = useRef(t);

  useEffect(() => {
    if (!CAPABILITIES.nativeDragDrop) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      unlisten = await listenNativeDocumentDrops((paths) => {
        // Every dropped path, not just paths[0]. The file-association route
        // already opens N documents at once (lib.rs walks the whole argv and
        // the macOS Opened queue), so dropping three PDFs used to open one and
        // discard the other two with no toast and no error — the same action
        // behaving differently depending on how the files arrived.
        if (paths.length === 0) return;
        void (async () => {
          for (const path of paths) {
            // Centralized classification distinguishes an unreadable folder
            // from a regular file without abusing `read_dir` as a type test.
            await openPlatformPathRef.current(path);
          }
        })().catch((err) => reportNativeRouteFailure("drag-drop", err));
      });
      if (cancelled) {
        safeUnlisten(unlisten);
        unlisten = null;
      }
    })().catch((err) => reportNativeRouteFailure("drag-drop", err));
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);

  // On web (and Tauri mobile) the native drag-drop event above doesn't exist,
  // and the HTML5 `onDrop` handler only lives on the Landing — which unmounts
  // once a document is open. A file dropped onto an already-open document then
  // hits the browser's default handler, which NAVIGATES to that file and tears
  // down the whole SPA: the open tab, undo stack, view state, and any edits
  // still inside the autosave debounce window. Make the entire window a drop
  // sink so that can't happen: swallow the default for file drags everywhere,
  // and adopt any drop the Landing didn't already claim (its own onDrop
  // preventDefault()s the ones it handles, so `defaultPrevented` dedupes).
  useEffect(() => {
    if (CAPABILITIES.nativeDragDrop) return;
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      if (!isFileDrag(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      void (async () => {
        for (const file of files) {
          try {
            await handleFile(file);
          } catch (err) {
            showPlatformOpenError(err, file.name, t, file.name);
          }
        }
      })().catch((err) => reportNativeRouteFailure("web-drop", err));
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [handleFile, t]);

  // Open a file from a native path through the normal in-app pipeline —
  // used by Finder file associations below and by the export toast's
  // "open" action (shell-opening the file would launch a second instance
  // instead of adding a tab here).
  const openPlatformPath = useCallback(
    async (path: string) => {
      if (!path) return;
      try {
        const target = await classifyOpenTargetFromPlatform(path);
        if (!target) return;
        if (target.isDirectory) {
          await handleFolderPath(target.path);
          return;
        }
        if (!target.kind) {
          const name = path.split(/[/\\]/).pop() ?? path;
          toast.error(
            t("error.unsupportedDocument.title"),
            unsupportedDocumentDetail(name, t),
          );
          return;
        }
        const payload = await readDocumentBytesFromPlatformPath(target.path);
        if (!payload) throw new Error("read-pdf-failed");
        await handleDocumentPayload(payload);
      } catch (err) {
        showPlatformOpenError(err, path, t, path);
      }
    },
    [handleDocumentPayload, handleFolderPath, t],
  );

  // Native listeners are deliberately installed once. Keep their delegate
  // fresh without reinstalling Tauri event subscriptions during editor renders.
  useEffect(() => {
    openPlatformPathRef.current = openPlatformPath;
    handleDocumentPayloadRef.current = handleDocumentPayload;
    translateRef.current = t;
  });

  // macOS file association: double-clicking a supported document in Finder
  // or choosing "Open With"
  // sends the path via Tauri's RunEvent::Opened → "file-open" event.
  // Register the live listener before draining Rust's cold-launch buffer
  // so an event cannot land between "drain" and "listen".
  useEffect(() => {
    if (!CAPABILITIES.nativePaths) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const openPath = (path: string) => openPlatformPathRef.current(path);
    const openQueue = new OpenHandoffQueue<string>({
      dedupeMs: DESKTOP_OPEN_DEDUPE_MS,
      open: openPath,
    });
    void (async () => {
      const { commands, unwrapCommand } = await import("../../platform/ipc");
      if (cancelled) return;
      unlisten = await listenNativeEvent<string>("file-open", (path) => {
        void commands.ackPendingOpenPath(path).catch(() => undefined);
        openQueue.enqueue(path);
      });
      if (cancelled) {
        safeUnlisten(unlisten);
        unlisten = null;
        return;
      }
      let pending: string[] = [];
      try {
        pending = unwrapCommand(await commands.drainPendingOpenPaths());
      } catch (err) {
        if (String(err).includes("runtime-expired")) setNativeExpired(true);
        return;
      }
      if (!cancelled && pending.length > 0) {
        openQueue.enqueueAll(pending);
      }
      if (cancelled) {
        safeUnlisten(unlisten);
        unlisten = null;
      }
    })().catch((err) => reportNativeRouteFailure("file-association", err));
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
    // Installed once. openPlatformPath changes identity on every editor
    // render (its chain reaches back to the active tab), and reinstalling
    // here meant unlisten + listen + drainPendingOpenPaths on every keystroke
    // in a Markdown document — hundreds of IPC round trips a second, with a
    // narrow window on each one where a file opened from Finder would land
    // between the two and be dropped. The delegate stays fresh through
    // openPlatformPathRef.
  }, [setNativeExpired]);

  // iOS/Android file association and share targets: the OS hands Tauri a
  // URL-like value, not a desktop path. Read it through the mobile fs plugin.
  useEffect(() => {
    if (!CAPABILITIES.mobileDocumentPicker) return;
    let unlisten: (() => void) | null = null;
    let removeAndroidFileOpenListener: (() => void) | null = null;
    let cancelled = false;
    const openMobileUrl = async (documentRef: MobileDocumentReference) => {
      const uri = mobileDocumentReferenceUri(documentRef);
      if (!uri) return;
      try {
        const payload = await readMobileDocumentFromPlatformUrl(documentRef);
        if (!payload) throw new Error("read-pdf-failed");
        await handleDocumentPayloadRef.current(payload);
      } catch (err) {
        showPlatformOpenError(
          err,
          mobileDocumentReferenceLabel(documentRef),
          translateRef.current,
          uri,
        );
      }
    };
    const openQueue = new OpenHandoffQueue<MobileDocumentReference>({
      dedupeMs: MOBILE_OPEN_DEDUPE_MS,
      key: mobileDocumentReferenceUri,
      open: openMobileUrl,
    });
    void (async () => {
      const { commands, unwrapCommand } = await import("../../platform/ipc");
      if (cancelled) return;
      const drainAndroidPending = () => {
        const bridge = window.ShioriAndroid;
        if (!bridge?.drainPendingDocumentOpens) return;
        // Keep the receiver (`bridge.`): JavaBridge methods cannot be called
        // detached. The optional call re-checks under the thunk because the
        // guard above does not narrow inside a closure.
        const bridgePending = parseMobileDocumentReferences(
          () => bridge.drainPendingDocumentOpens?.() ?? "",
        );
        for (const documentRef of bridgePending) {
          openQueue.enqueue(documentRef);
        }
      };
      const onAndroidFileOpen = (event: Event) => {
        const documentRef = (event as CustomEvent<unknown>).detail;
        if (isMobileDocumentReference(documentRef)) {
          openQueue.enqueue(documentRef);
          return;
        }
        drainAndroidPending();
      };
      window.addEventListener("shiori-android-file-open", onAndroidFileOpen);
      removeAndroidFileOpenListener = () => {
        window.removeEventListener(
          "shiori-android-file-open",
          onAndroidFileOpen,
        );
      };
      unlisten = await listenNativeEvent<string>("file-open", (path) => {
        void commands.ackPendingOpenPath(path).catch(() => undefined);
        openQueue.enqueue(path);
      });
      if (cancelled) {
        safeUnlisten(unlisten);
        unlisten = null;
        safeUnlisten(removeAndroidFileOpenListener);
        removeAndroidFileOpenListener = null;
        return;
      }
      drainAndroidPending();
      let pending: string[] = [];
      try {
        pending = unwrapCommand(await commands.drainPendingOpenPaths());
      } catch (err) {
        showPlatformOpenError(err, undefined, translateRef.current);
        return;
      }
      if (!cancelled && pending.length > 0) {
        openQueue.enqueueAll(pending);
      }
    })().catch((err) => reportNativeRouteFailure("mobile-open", err));
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
      safeUnlisten(removeAndroidFileOpenListener);
    };
    // Installed once, same reason as the file-association listener above:
    // handleDocumentPayload changes identity on every editor render, and
    // reinstalling the share-intent listener on each one risks dropping an
    // incoming document between unlisten and listen.
  }, []);

  // Embedded Browser panel: Rust pushes nav-state as the native webview
  // navigates (reflected into the address bar), and the terminal `open
  // https://…` shim asks — via Rust — to open a URL in the panel.
  useEffect(() => {
    if (!CAPABILITIES.embeddedBrowserPanel) return;
    let cancelled = false;
    let offNav: (() => void) | null = null;
    let offOpen: (() => void) | null = null;
    const { setWebPanel, openBrowserPanel } = useAppStore.getState();
    void (async () => {
      const [navUnlisten, openUnlisten] = await Promise.all([
        listenWebPanelNav((state) => setWebPanel(state)),
        listenWebPanelOpenRequest((url) => openBrowserPanel(url)),
      ]);
      if (cancelled) {
        safeUnlisten(navUnlisten);
        safeUnlisten(openUnlisten);
        return;
      }
      offNav = navUnlisten;
      offOpen = openUnlisten;
    })().catch((err) => reportNativeRouteFailure("browser-panel", err));
    return () => {
      cancelled = true;
      safeUnlisten(offNav);
      safeUnlisten(offOpen);
    };
  }, []);

  // openPlatformPath is also used by App (ExportDialog's "open exported"
  // action), so it is returned rather than kept private to the hook.
  return { openPlatformPath };
}
