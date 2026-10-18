import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  buildRunnableHtml,
  isApprovableDependencyKind,
  remoteDependencyFromViolation,
  remoteDependencyKey,
  type ApprovableDependencyKind,
  type ApprovedRemoteOrigins,
  type RemoteDependency,
  type RemoteDependencyKind,
} from "../../documents/runnableHtml";
import { T } from "../../design/tokens";
import { openExternalUrl } from "../../platform";
import { Ic } from "./icons";
import { IconBtn } from "./ui";
import {
  DocumentControlBar,
  LoadingBlock,
  RenderError,
} from "./DocumentViewerParts";
import {
  eventClientPoint,
  gestureScale,
  isElementTarget,
  scrollerCenter,
  useDebouncedScrollTopChange,
  useScrollableZoomGestures,
  wheelZoomFactor,
} from "./documentViewerGestures";

const RUN_FRAME_MIN_HEIGHT = 320;

// Stable empty fallback so derived state keeps referential equality across
// renders that have no dependency reports yet.
const EMPTY_REMOTE_DEPENDENCIES: RemoteDependency[] = [];
const EMPTY_APPROVAL_KEYS: ReadonlySet<string> = new Set();

// Session-scoped consent for run-mode remote dependencies, keyed by document
// identity and holding remoteDependencyKey() strings. Deliberately in-memory
// (v1): approvals are forgotten on app reload, which is the conservative
// default for executing remote code. Durable persistence would need a stable
// document id that survives sessions.
const sessionRunApprovals = new Map<string, ReadonlySet<string>>();

const REMOTE_DEPENDENCY_KIND_KEYS: Record<RemoteDependencyKind, string> = {
  script: "documents.runDepsKindScript",
  stylesheet: "documents.runDepsKindStylesheet",
  image: "documents.runDepsKindImage",
  media: "documents.runDepsKindMedia",
  frame: "documents.runDepsKindFrame",
  font: "documents.runDepsKindFont",
  connect: "documents.runDepsKindConnect",
  other: "documents.runDepsKindOther",
};

// Slim disclosure bar above the run frame: run mode is offline by design, so
// every remote dependency the document references is blocked — this explains
// the otherwise silent "Can't find variable: THREE"-class failures. Approvable
// kinds carry a checkbox; applying the selection rebuilds the frame with those
// origins added to the matching CSP directives only.
function RunDependencyNotice({
  dependencies,
  appliedKeys,
  selectedKeys,
  selectionDirty,
  onToggle,
  onApply,
}: {
  dependencies: RemoteDependency[];
  appliedKeys: ReadonlySet<string>;
  selectedKeys: ReadonlySet<string>;
  selectionDirty: boolean;
  onToggle: (dependencyKey: string) => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const blockedCount = dependencies.filter(
    (dependency) => !appliedKeys.has(remoteDependencyKey(dependency)),
  ).length;
  const hasApprovable = dependencies.some((dependency) =>
    isApprovableDependencyKind(dependency.kind),
  );
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "6px 12px",
        background: T.cream,
        borderBottom: `1px solid ${T.rule}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            minWidth: 0,
            flex: 1,
            color: T.ink2,
            font: `500 12px/1.35 ${T.sans}`,
          }}
        >
          {blockedCount > 0
            ? t("documents.runDepsBlocked", { count: blockedCount })
            : t("documents.runDepsAllowed", {
                count: dependencies.length - blockedCount,
              })}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          style={{
            flex: "0 0 auto",
            height: 26,
            padding: "0 9px",
            borderRadius: 6,
            border: `1px solid ${T.rule}`,
            background: T.surface,
            color: T.ink2,
            font: `500 12px/1 ${T.sans}`,
            cursor: "pointer",
          }}
        >
          {expanded ? t("documents.runDepsHide") : t("documents.runDepsShow")}
        </button>
      </div>
      {expanded ? (
        <>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: "2px 0 0",
              maxHeight: 168,
              overflow: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {dependencies.map((dependency) => {
              const dependencyKey = remoteDependencyKey(dependency);
              const approvable = isApprovableDependencyKind(dependency.kind);
              const details = (
                <>
                  <span
                    style={{
                      flex: "0 0 auto",
                      color: T.dim,
                      font: `600 10px/1.6 ${T.mono}`,
                      letterSpacing: 0.4,
                      textTransform: "uppercase",
                    }}
                  >
                    {t(REMOTE_DEPENDENCY_KIND_KEYS[dependency.kind])}
                  </span>
                  <span
                    style={{
                      flex: "0 0 auto",
                      color: T.ink2,
                      font: `600 12px/1.4 ${T.sans}`,
                    }}
                  >
                    {dependency.origin}
                  </span>
                  <span
                    style={{
                      minWidth: 0,
                      color: T.dim,
                      font: `500 11px/1.4 ${T.mono}`,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {dependency.url}
                  </span>
                </>
              );
              return (
                <li key={dependencyKey} style={{ minWidth: 0 }}>
                  {approvable ? (
                    <label
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 8,
                        minWidth: 0,
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(dependencyKey)}
                        onChange={() => onToggle(dependencyKey)}
                        style={{
                          flex: "0 0 auto",
                          margin: 0,
                          accentColor: T.accent,
                          transform: "translateY(2px)",
                        }}
                      />
                      {details}
                    </label>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 8,
                        minWidth: 0,
                        // Keep text columns aligned with checkbox rows.
                        paddingLeft: 21,
                      }}
                    >
                      {details}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {hasApprovable ? (
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                padding: "2px 0 4px",
              }}
            >
              <button
                type="button"
                onClick={onApply}
                disabled={!selectionDirty}
                style={{
                  flex: "0 0 auto",
                  height: 26,
                  padding: "0 12px",
                  borderRadius: 6,
                  border: `1px solid ${selectionDirty ? T.accent : T.rule}`,
                  background: selectionDirty ? T.accent : T.surface,
                  color: selectionDirty ? T.onAccent : T.dim,
                  font: `600 12px/1 ${T.sans}`,
                  cursor: selectionDirty ? "pointer" : "default",
                }}
              >
                {t("documents.runDepsAllowSelected")}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function HtmlRefreshButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <IconBtn
      title={t("documents.refreshHtml")}
      onClick={onClick}
      tone="outline"
    >
      <Ic.refresh aria-hidden />
    </IconBtn>
  );
}

function HtmlDocumentFrame({
  title,
  html,
  loading,
  error,
  errorMessage,
  scrollTop,
  onScrollTopChange,
  zoom,
  onZoomChange,
  refreshKey,
  onLinkOpenFailed,
}: {
  title: string;
  html: string;
  loading: boolean;
  error: string | null;
  errorMessage: string;
  scrollTop: number;
  onScrollTopChange: (scrollTop: number) => void;
  zoom: number;
  onZoomChange?: (zoom: number) => void;
  refreshKey: number;
  onLinkOpenFailed: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameScrollerRef = useRef<HTMLElement | null>(null);
  const scrollTopRef = useRef(scrollTop);
  // Pinch state lives in refs, not in the listener effect's closure. A pinch
  // spans many events and the effect can re-run mid-gesture; effect-local
  // variables would reset to empty and every subsequent pointermove would
  // bail on "unknown pointer id" until the reader lifted and touched again.
  const framePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const framePinchBaseRef = useRef<number | null>(null);
  const [loadTick, setLoadTick] = useState(0);
  const { report: reportHtmlScroll } =
    useDebouncedScrollTopChange(onScrollTopChange);
  const zoomGestures = useScrollableZoomGestures(
    frameScrollerRef,
    zoom,
    onZoomChange,
  );

  useEffect(() => {
    scrollTopRef.current = scrollTop;
  }, [scrollTop]);

  useEffect(() => {
    if (loading || error || !html) return;
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    const win = iframe?.contentWindow;
    const frameScroller = doc?.scrollingElement as HTMLElement | null;
    if (!iframe || !doc || !win || !frameScroller) return;
    frameScrollerRef.current = frameScroller;

    const timerIds: number[] = [];
    const syncScroll = () => {
      if (Math.abs(frameScroller.scrollTop - scrollTopRef.current) > 1) {
        frameScroller.scrollTop = scrollTopRef.current;
      }
    };
    const handleFrameScroll = () => {
      const nextScrollTop = frameScroller.scrollTop;
      scrollTopRef.current = nextScrollTop;
      reportHtmlScroll(nextScrollTop);
    };

    timerIds.push(window.setTimeout(syncScroll, 0));
    timerIds.push(window.setTimeout(syncScroll, 50));

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!isElementTarget(target)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor?.href) return;
      event.preventDefault();
      void openExternalUrl(anchor.href).catch(onLinkOpenFailed);
    };
    doc.addEventListener("click", handleClick);
    win.addEventListener("scroll", handleFrameScroll, { passive: true });

    const framePoint = (event: Event) => {
      const point = eventClientPoint(event);
      return point ?? scrollerCenter(frameScroller);
    };
    const handleFrameWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const point = framePoint(event);
      zoomGestures.zoomByFactor(
        point.x,
        point.y,
        wheelZoomFactor(event.deltaY),
      );
    };
    const handleFrameGestureStart = (event: Event) => {
      event.preventDefault();
      zoomGestures.startGesture();
    };
    const handleFrameGestureChange = (event: Event) => {
      const scaleValue = gestureScale(event);
      if (scaleValue == null) return;
      event.preventDefault();
      const point = framePoint(event);
      zoomGestures.changeGesture(point.x, point.y, scaleValue);
    };
    const handleFrameGestureEnd = (event: Event) => {
      event.preventDefault();
      zoomGestures.endGesture();
    };
    const supportsAppleGesture = "GestureEvent" in win;
    const activePointers = framePointersRef.current;
    const beginFramePinch = () => {
      if (activePointers.size !== 2) return;
      const [a, b] = Array.from(activePointers.values());
      if (!a || !b) return;
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      if (distance <= 0) return;
      framePinchBaseRef.current = distance;
      zoomGestures.startGesture();
    };
    const handleFramePointerDown = (event: PointerEvent) => {
      if (supportsAppleGesture || event.pointerType !== "touch") return;
      activePointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      beginFramePinch();
    };
    const handleFramePointerMove = (event: PointerEvent) => {
      if (supportsAppleGesture || event.pointerType !== "touch") return;
      if (!activePointers.has(event.pointerId)) return;
      activePointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      const pinchBaseDistance = framePinchBaseRef.current;
      if (activePointers.size !== 2 || pinchBaseDistance == null) return;
      const [a, b] = Array.from(activePointers.values());
      if (!a || !b) return;
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      if (distance <= 0) return;
      event.preventDefault();
      zoomGestures.changeGesture(
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        distance / pinchBaseDistance,
      );
    };
    const handleFramePointerEnd = (event: PointerEvent) => {
      if (supportsAppleGesture || event.pointerType !== "touch") return;
      activePointers.delete(event.pointerId);
      if (activePointers.size >= 2) {
        beginFramePinch();
        return;
      }
      if (framePinchBaseRef.current !== null) zoomGestures.endGesture();
      framePinchBaseRef.current = null;
    };
    const frameWheelOptions: AddEventListenerOptions = {
      capture: true,
      passive: false,
    };
    const previousTouchAction = doc.documentElement.style.touchAction;
    doc.documentElement.style.touchAction = "pan-x pan-y";
    win?.addEventListener("wheel", handleFrameWheel, frameWheelOptions);
    win?.addEventListener("gesturestart", handleFrameGestureStart, {
      passive: false,
    });
    win?.addEventListener("gesturechange", handleFrameGestureChange, {
      passive: false,
    });
    win?.addEventListener("gestureend", handleFrameGestureEnd, {
      passive: false,
    });
    doc.addEventListener("pointerdown", handleFramePointerDown, {
      capture: true,
      passive: true,
    });
    doc.addEventListener("pointermove", handleFramePointerMove, frameWheelOptions);
    doc.addEventListener("pointerup", handleFramePointerEnd, {
      capture: true,
      passive: true,
    });
    doc.addEventListener("pointercancel", handleFramePointerEnd, {
      capture: true,
      passive: true,
    });

    return () => {
      frameScrollerRef.current = null;
      doc.removeEventListener("click", handleClick);
      win.removeEventListener("scroll", handleFrameScroll);
      win?.removeEventListener("wheel", handleFrameWheel, { capture: true });
      win?.removeEventListener("gesturestart", handleFrameGestureStart);
      win?.removeEventListener("gesturechange", handleFrameGestureChange);
      win?.removeEventListener("gestureend", handleFrameGestureEnd);
      doc.removeEventListener("pointerdown", handleFramePointerDown, true);
      doc.removeEventListener("pointermove", handleFramePointerMove, true);
      doc.removeEventListener("pointerup", handleFramePointerEnd, true);
      doc.removeEventListener("pointercancel", handleFramePointerEnd, true);
      doc.documentElement.style.touchAction = previousTouchAction;
      // Deliberately no endGesture() here. gestureend/pointerup/pointercancel
      // already clear the baseline, and clearing it on teardown was the bug:
      // this effect re-runs whenever the frame is rebuilt, and a baseline
      // dropped mid-pinch makes the next scale multiply against the zoom it
      // has already applied, compounding away to the clamp in a few frames.
      // A stale baseline is harmless — startGesture overwrites it.
      for (const id of timerIds) window.clearTimeout(id);
    };
  }, [
    error,
    html,
    loadTick,
    loading,
    onLinkOpenFailed,
    reportHtmlScroll,
    zoomGestures,
  ]);

  // Applying the zoom is its own effect: it is the only thing here that
  // depends on `zoom`, and having it in the listener effect meant every
  // zoom step tore down and reinstalled the gesture listeners mid-gesture.
  // CSS `zoom` reflows the iframe document. The frame itself remains the
  // viewport, so its document owns native wheel/trackpad scrolling.
  useEffect(() => {
    if (loading || error || !html) return;
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    doc.documentElement.style.setProperty(
      "zoom",
      zoom === 1 ? "" : String(zoom),
    );
  }, [error, html, loadTick, loading, zoom]);

  // Drop any pinch in flight when the frame's document is replaced.
  //
  // The iframe is keyed on refreshKey, so React swaps the element out from
  // under a gesture: the old document will never deliver the pointerup or
  // gestureend that would normally end it. The pinch state lives in refs (it
  // has to — see framePointersRef), so without this the next frame starts
  // with phantom fingers still down. Two of them are enough to make every
  // later pointermove bail on `activePointers.size !== 2`, freezing pinch
  // until the reader lifts and touches again, and a surviving baseline makes
  // the first scale measure against a zoom from the previous document.
  //
  // Deliberately scoped to frame identity rather than folded into the
  // listener effect: that effect also depends on callback props, and clearing
  // the baseline whenever one of those churns is what caused trackpad zoom to
  // compound to the clamp.
  useEffect(() => {
    // Captured on the way in: this is the map the frame being torn down was
    // using, which is exactly the one whose entries have to go.
    const pointers = framePointersRef.current;
    return () => {
      pointers.clear();
      framePinchBaseRef.current = null;
      zoomGestures.endGesture();
    };
    // Deliberately NOT keyed on loadTick. That only says the current document
    // finished loading, which for a frame with slow subresources can land in
    // the middle of a pinch the reader already started — clearing the
    // baseline there is exactly the compounding bug above, just triggered by
    // a late load event instead of a zoom step. Only refreshKey (React swaps
    // the element) and html (new srcdoc) actually replace the document.
  }, [html, refreshKey, zoomGestures]);

  return (
    <div
      className="shioriHtmlFrameShell"
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        background: T.surface,
      }}
    >
      {error ? (
        <div style={{ padding: 24 }}>
          <RenderError message={errorMessage} />
        </div>
      ) : loading ? (
        <div style={{ padding: 24 }}>
          <LoadingBlock />
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          className="shioriHtmlFrame"
          title={title}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          key={refreshKey}
          srcDoc={html}
          onLoad={() => setLoadTick((tick) => tick + 1)}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            minHeight: "100%",
            border: 0,
            background: T.surface,
          }}
        />
      )}
    </div>
  );
}

// HTML documents have two modes: a safe static read (scripts stripped) and an
// opt-in sandboxed run mode that executes the document's own scripts inside a
// locked-down, opaque-origin iframe (see runnableHtml.ts). The run affordance
// only appears when the file actually contains scripts.
export function HtmlDocumentView({
  title,
  documentId,
  html,
  rawText,
  loading,
  error,
  errorMessage,
  scrollTop,
  onScrollTopChange,
  zoom,
  onZoomChange,
  imageNotice,
  toolbar,
  refreshKey,
  onRefresh,
  onLinkOpenFailed,
}: {
  title: string;
  documentId: string;
  html: string;
  rawText: string;
  loading: boolean;
  error: string | null;
  errorMessage: string;
  scrollTop: number;
  onScrollTopChange: (scrollTop: number) => void;
  zoom: number;
  onZoomChange?: (zoom: number) => void;
  imageNotice: ReactNode;
  toolbar?: ReactNode;
  refreshKey: number;
  onRefresh: () => void;
  onLinkOpenFailed: () => void;
}) {
  const { t } = useTranslation();
  const runIdentity = `${documentId}:${rawText.length}`;
  const [runState, setRunState] = useState({
    identity: runIdentity,
    running: false,
  });
  const running = runState.identity === runIdentity && runState.running;
  const setRunningForCurrentDocument = useCallback(
    (nextRunning: boolean) => {
      setRunState({ identity: runIdentity, running: nextRunning });
    },
    [runIdentity],
  );
  // Running scripts is a fresh, explicit opt-in per document — never inherited
  // when the same viewer instance is reused for a different file.
  // Only offer "run" when the document actually contains scripts; a static
  // page has nothing to execute, so the affordance would just be noise.
  const hasScript = useMemo(() => /<script[\s/>]/i.test(rawText), [rawText]);
  const canRun = !loading && !error && hasScript;
  const canRefresh = !loading && !error;
  const htmlStatus = imageNotice ?? (
    running ? (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          color: T.ink2,
          font: `500 12px/1.35 ${T.sans}`,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: T.accent,
            flex: "0 0 auto",
          }}
        />
        {t("documents.runningStatus")}
      </span>
    ) : canRun ? (
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: T.dim,
          font: `500 12px/1.35 ${T.sans}`,
        }}
      >
        {t("documents.runHtmlHint")}
      </span>
    ) : null
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        // minWidth:0 lets the viewer shrink inside its flex-row parent (it sits
        // beside the optional terminal/browser rail); without it, wide content
        // blows the flex item past the viewport and pushes everything right.
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <DocumentControlBar
        leading={htmlStatus}
        trailing={
          <>
            {running ? (
              <button
                type="button"
                onClick={() => setRunningForCurrentDocument(false)}
                style={{
                  flex: "0 0 auto",
                  height: 26,
                  padding: "0 12px",
                  borderRadius: 6,
                  border: `1px solid ${T.rule}`,
                  background: T.surface,
                  color: T.ink2,
                  font: `500 12px/1 ${T.sans}`,
                  cursor: "pointer",
                }}
              >
                {t("documents.stopHtml")}
              </button>
            ) : canRun ? (
              <button
                type="button"
                onClick={() => setRunningForCurrentDocument(true)}
                title={t("documents.runHtmlHint")}
                style={{
                  flex: "0 0 auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 26,
                  padding: "0 12px",
                  borderRadius: 6,
                  border: `1px solid ${T.accent}`,
                  background: T.accent,
                  color: T.onAccent,
                  font: `600 12px/1 ${T.sans}`,
                  cursor: "pointer",
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 12 12"
                  aria-hidden
                  fill="currentColor"
                >
                  <path d="M2.5 1.5 L10 6 L2.5 10.5 Z" />
                </svg>
                {t("documents.runHtml")}
              </button>
            ) : null}
            {canRefresh ? <HtmlRefreshButton onClick={onRefresh} /> : null}
            {toolbar}
          </>
        }
      />
      {running ? (
        <RunHtmlFrame
          title={title}
          documentKey={runIdentity}
          rawHtml={rawText}
          zoom={zoom}
          onZoomChange={onZoomChange}
          refreshKey={refreshKey}
        />
      ) : (
        <HtmlDocumentFrame
          title={title}
          html={html}
          loading={loading}
          error={error}
          errorMessage={errorMessage}
          scrollTop={scrollTop}
          onScrollTopChange={onScrollTopChange}
          zoom={zoom}
          onZoomChange={onZoomChange}
          refreshKey={refreshKey}
          onLinkOpenFailed={onLinkOpenFailed}
        />
      )}
    </div>
  );
}

// Executes an HTML document inside an opaque-origin sandbox. Because the frame
// is cross-origin to the host, height changes come back over postMessage from
// the bridge that buildRunnableHtml injects. Link clicks are kept inside the
// sandbox instead of being auto-opened by the host.
function RunHtmlFrame({
  title,
  documentKey,
  rawHtml,
  zoom,
  onZoomChange,
  refreshKey,
}: {
  title: string;
  documentKey: string;
  rawHtml: string;
  zoom: number;
  onZoomChange?: (zoom: number) => void;
  refreshKey: number;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [runResources, setRunResources] =
    useState<RunnableHtmlResources | null>(null);
  const runResourceKey = runResources?.documentUrl ?? "";
  const [runtimeErrorState, setRuntimeErrorState] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const runtimeError =
    runtimeErrorState?.key === runResourceKey ? runtimeErrorState.message : null;
  // Remote loads the CSP blocked at runtime, relayed by the bridge. Kept
  // separate from the static scan because CSS-driven loads (fonts, @import)
  // only surface here.
  const [runtimeDependencyState, setRuntimeDependencyState] = useState<{
    key: string;
    entries: RemoteDependency[];
  } | null>(null);
  const runtimeDependencies =
    runtimeDependencyState?.key === runResourceKey
      ? runtimeDependencyState.entries
      : EMPTY_REMOTE_DEPENDENCIES;
  const staticDependencies =
    runResources?.remoteDependencies ?? EMPTY_REMOTE_DEPENDENCIES;
  const remoteDependencies = useMemo(() => {
    const merged = new Map<string, RemoteDependency>();
    for (const dependency of [...staticDependencies, ...runtimeDependencies]) {
      const key = remoteDependencyKey(dependency);
      if (!merged.has(key)) merged.set(key, dependency);
    }
    return [...merged.values()];
  }, [staticDependencies, runtimeDependencies]);
  // Per-dependency consent. `applied` is what the current frame was built
  // with; `selected` is the checkbox state, which only takes effect once the
  // user explicitly re-runs. Keyed by document so a viewer reused for another
  // file never inherits approvals.
  const [approvalState, setApprovalState] = useState<{
    key: string;
    applied: ReadonlySet<string>;
    selected: ReadonlySet<string>;
  } | null>(null);
  const sessionApproved =
    sessionRunApprovals.get(documentKey) ?? EMPTY_APPROVAL_KEYS;
  const applied =
    approvalState?.key === documentKey ? approvalState.applied : sessionApproved;
  const selected =
    approvalState?.key === documentKey ? approvalState.selected : applied;
  const appliedSignature = useMemo(
    () => [...applied].sort().join("\n"),
    [applied],
  );
  const selectionDirty =
    selected.size !== applied.size ||
    [...selected].some((key) => !applied.has(key));
  const toggleDependency = useCallback(
    (dependencyKey: string) => {
      const nextSelected = new Set(selected);
      if (!nextSelected.delete(dependencyKey)) nextSelected.add(dependencyKey);
      setApprovalState({ key: documentKey, applied, selected: nextSelected });
    },
    [applied, documentKey, selected],
  );
  const applySelection = useCallback(() => {
    const nextApplied = new Set(selected);
    sessionRunApprovals.set(documentKey, nextApplied);
    setApprovalState({
      key: documentKey,
      applied: nextApplied,
      selected: nextApplied,
    });
  }, [documentKey, selected]);
  const [frameViewport, setFrameViewport] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const zoomGestures = useScrollableZoomGestures(
    scrollerRef,
    zoom,
    onZoomChange,
  );

  useEffect(() => {
    // Deriving the origins from the signature string (not the Set) keeps the
    // dependency list value-based: applying the same approvals twice must not
    // rebuild and reload the frame.
    const resources = createRunnableHtmlResources(
      rawHtml,
      approvedOriginsFromKeys(
        appliedSignature ? appliedSignature.split("\n") : [],
      ),
    );
    const timer = window.setTimeout(() => setRunResources(resources), 0);
    return () => {
      window.clearTimeout(timer);
      window.setTimeout(() => revokeRunnableHtmlResources(resources), 0);
    };
  }, [appliedSignature, rawHtml, refreshKey]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let rafId = 0;

    const measure = () => {
      const rect = scroller.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width || scroller.clientWidth));
      const height = Math.max(
        RUN_FRAME_MIN_HEIGHT,
        Math.round(rect.height || scroller.clientHeight),
      );
      setFrameViewport((previous) =>
        previous?.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    const scheduleMeasure = () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(measure);
    };

    scheduleMeasure();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleMeasure);
      resizeObserver.observe(scroller);
    } else {
      window.addEventListener("resize", scheduleMeasure);
    }

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      // The frame is opaque-origin, so event.origin is unreliable; identify it
      // by its window handle and our own message tag instead.
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data as
        | {
            source?: string;
            type?: string;
            value?: unknown;
            clientX?: unknown;
            clientY?: unknown;
            blockedURI?: unknown;
            violatedDirective?: unknown;
          }
        | null;
      if (!data || data.source !== "shiori-run-frame") return;
      // The sandbox still reports its content height; the host no longer
      // sizes the frame to it (see the iframe's style), so it is ignored.
      if (data.type === "zoom" && typeof data.value === "number") {
        const rect = iframe.getBoundingClientRect();
        const x =
          typeof data.clientX === "number"
            ? rect.left + data.clientX
            : rect.left + rect.width / 2;
        const y =
          typeof data.clientY === "number"
            ? rect.top + data.clientY
            : rect.top + rect.height / 2;
        zoomGestures.zoomByFactor(x, y, data.value);
      } else if (data.type === "error" && typeof data.value === "string") {
        setRuntimeErrorState({ key: runResourceKey, message: data.value });
      } else if (data.type === "cspViolation") {
        const entry = remoteDependencyFromViolation(
          typeof data.blockedURI === "string" ? data.blockedURI : "",
          typeof data.violatedDirective === "string"
            ? data.violatedDirective
            : "",
        );
        if (!entry) return;
        setRuntimeDependencyState((previous) => {
          const entries =
            previous?.key === runResourceKey ? previous.entries : [];
          const entryKey = remoteDependencyKey(entry);
          if (
            entries.some(
              (existing) => remoteDependencyKey(existing) === entryKey,
            )
          ) {
            return previous?.key === runResourceKey
              ? previous
              : { key: runResourceKey, entries };
          }
          return { key: runResourceKey, entries: [...entries, entry] };
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [runResourceKey, zoomGestures]);

  useEffect(() => {
    if (!runResources) return;
    const iframe = iframeRef.current;
    iframe?.contentWindow?.postMessage(
      { source: "shiori-host-frame", type: "zoom", value: zoom },
      "*",
    );
  }, [runResources, zoom]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {remoteDependencies.length > 0 ? (
        <RunDependencyNotice
          dependencies={remoteDependencies}
          appliedKeys={applied}
          selectedKeys={selected}
          selectionDirty={selectionDirty}
          onToggle={toggleDependency}
          onApply={applySelection}
        />
      ) : null}
      <div
        ref={scrollerRef}
        className="shioriHtmlFrameShell"
        style={{ flex: 1, minHeight: 0, overflow: "auto", background: T.surface }}
      >
        {frameViewport && runResources ? (
          <iframe
            ref={iframeRef}
            className="shioriHtmlFrame"
            title={title}
            // Opaque-origin sandbox: scripts run, but the frame has NO access to
            // the app's origin, DOM, storage, or Tauri IPC. Combined with the CSP
            // injected by buildRunnableHtml (connect-src 'none', generated data:
            // scripts), the content can animate but cannot phone home, fetch
            // remote code, or read anything outside its own box. NEVER add
            // allow-same-origin — that would let the frame escape the sandbox.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            key={runResourceKey}
            src={runResourceKey}
            width={frameViewport.width}
            height={frameViewport.height}
            onLoad={() => {
              setRuntimeErrorState(null);
              iframeRef.current?.contentWindow?.postMessage(
                { source: "shiori-host-frame", type: "zoom", value: zoom },
                "*",
              );
            }}
            style={{
              display: "block",
              width: "100%",
              // The frame stays exactly one viewport tall, so its own document
              // scrolls. Sizing it to the content height (what the sandbox
              // reports via postMessage) put the scrollbar on the container
              // outside — and a wheel event over an iframe is delivered to
              // that iframe's window, never to the parent. The frame had
              // nothing to scroll and the parent never heard the wheel, so a
              // long document was simply stuck the moment Run was pressed.
              // Preview mode had the same defect and was fixed the same way.
              height: `${frameViewport.height}px`,
              border: 0,
              background: T.surface,
            }}
          />
        ) : (
          <div style={{ padding: 24 }}>
            <LoadingBlock />
          </div>
        )}
        {runtimeError ? (
          <div
            role="alert"
            style={{
              position: "sticky",
              left: 12,
              bottom: 12,
              maxWidth: "min(640px, calc(100% - 24px))",
              margin: 12,
              padding: "10px 12px",
              border: `1px solid ${T.rect}`,
              borderRadius: 6,
              background: T.cream,
              color: T.rect,
              font: `500 12px/1.45 ${T.mono}`,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {runtimeError}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type RunnableHtmlResources = {
  documentUrl: string;
  remoteDependencies: RemoteDependency[];
};

function createRunnableHtmlResources(
  rawHtml: string,
  allowRemoteOrigins?: ApprovedRemoteOrigins,
): RunnableHtmlResources {
  const { html, remoteDependencies } = buildRunnableHtml(rawHtml, {
    externalizeScript: toDataScriptUrl,
    allowRemoteOrigins,
  });
  const documentUrl = URL.createObjectURL(
    new Blob([html], { type: "text/html;charset=utf-8" }),
  );
  return { documentUrl, remoteDependencies };
}

// Approval keys are remoteDependencyKey() strings — "<kind>|<url>", split on
// the FIRST "|" because the URL may legitimately contain one. Only approvable
// kinds grant anything; malformed entries grant nothing.
function approvedOriginsFromKeys(
  keys: readonly string[],
): ApprovedRemoteOrigins {
  const buckets: Record<ApprovableDependencyKind, Set<string>> = {
    script: new Set(),
    stylesheet: new Set(),
    image: new Set(),
    media: new Set(),
  };
  for (const key of keys) {
    const separator = key.indexOf("|");
    if (separator <= 0) continue;
    const kind = key.slice(0, separator) as RemoteDependencyKind;
    if (!isApprovableDependencyKind(kind)) continue;
    try {
      buckets[kind].add(new URL(key.slice(separator + 1)).origin);
    } catch {
      // Ignored: a key that does not parse cannot widen the CSP.
    }
  }
  return {
    script: [...buckets.script],
    stylesheet: [...buckets.stylesheet],
    image: [...buckets.image],
    media: [...buckets.media],
  };
}

function revokeRunnableHtmlResources(resources: RunnableHtmlResources) {
  URL.revokeObjectURL(resources.documentUrl);
}

function toDataScriptUrl(source: string): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}
