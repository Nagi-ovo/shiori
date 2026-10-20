import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import type { DocumentKind } from "../../documents/types";
import { renderSafeHtml } from "../../documents/renderSafeHtml";
import { documentLinkAction } from "../../documents/documentLinks";
import { highlightCodeBlocksNearView } from "../../documents/highlightCodeBlocksNearView";
import {
  previewSourceLine,
  scrollPreviewToSourceLine,
} from "../../documents/markdownScrollAnchor";
import {
  resolveDocumentImageResources,
  type DocumentImageSummary,
  type ReadLocalImage,
  type RemoteImagePolicy,
} from "../../documents/imageResources";
import { T } from "../../design/tokens";
import { openExternalUrl } from "../../platform";
import {
  DEFAULT_MARKDOWN_APPEARANCE,
  markdownFontFamilyCss,
  type MarkdownAppearance,
} from "../../documents/markdownAppearance";
import { toast } from "../toast";
import {
  DocumentControlBar,
  LoadingBlock,
  MarkdownEditorLoading,
  MarkdownModeToggle,
  RemoteImageNotice,
  RenderError,
} from "./DocumentViewerParts";
import { HtmlDocumentView } from "./DocumentViewerHtml";
import {
  isElementTarget,
  useDebouncedScrollTopChange,
  useScrollableZoomGestures,
} from "./documentViewerGestures";

type Props = {
  kind: Extract<DocumentKind, "markdown" | "html">;
  title: string;
  text: string;
  documentId?: string;
  scrollTop: number;
  onScrollTopChange: (scrollTop: number) => void;
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  toolbar?: ReactNode;
  sourcePath?: string;
  remoteImagePolicy?: RemoteImagePolicy;
  readLocalImage?: ReadLocalImage;
  renderHtml?: typeof renderSafeHtml;
  markdownMode?: MarkdownViewMode;
  onMarkdownModeChange?: (mode: MarkdownViewMode) => void;
  onMarkdownTextChange?: (text: string) => void;
  markdownAppearance?: MarkdownAppearance;
  markdownHeadingColor?: string;
};

export type MarkdownViewMode = "preview" | "edit";

type RenderedDocument = {
  kind: Extract<DocumentKind, "markdown" | "html">;
  text: string;
  resourceKey: string;
  html: string;
  imageSummary: DocumentImageSummary;
  error: string | null;
};

export const SCROLL_REPORT_DEBOUNCE_MS = 180;
export const TEXT_ZOOM_MIN = 0.35;
export const TEXT_ZOOM_MAX = 8;
export const TRACKPAD_WHEEL_DELTA_LIMIT = 40;
export const TRACKPAD_WHEEL_ZOOM_SENSITIVITY = 0.005;
// The editor once loaded, so entering edit mode can render it outright:
// through React.lazy the first entry always suspended (the factory runs on
// first render, cached module or not), and React 19 holds a shown Suspense
// fallback for ~300 ms, which was the whole of the first Edit click's lag.
let loadedMarkdownLiveEditor:
  | typeof import("./MarkdownLiveEditor").MarkdownLiveEditor
  | null = null;
const loadMarkdownLiveEditor = () =>
  import("./MarkdownLiveEditor").then((module) => {
    loadedMarkdownLiveEditor = module.MarkdownLiveEditor;
    return module;
  });
const LazyMarkdownLiveEditor = lazy(async () => {
  const module = await loadMarkdownLiveEditor();
  return { default: module.MarkdownLiveEditor };
});

export function DocumentViewer({
  kind,
  title,
  text,
  documentId,
  scrollTop,
  onScrollTopChange,
  zoom = 1,
  onZoomChange,
  toolbar,
  sourcePath,
  remoteImagePolicy = "ask",
  readLocalImage,
  renderHtml = renderSafeHtml,
  markdownMode: markdownModeProp = "preview",
  onMarkdownModeChange,
  onMarkdownTextChange,
  markdownAppearance = DEFAULT_MARKDOWN_APPEARANCE,
  markdownHeadingColor = T.ink,
}: Props) {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLElement | null>(null);
  const setScrollerNode = useCallback((node: HTMLElement | null) => {
    scrollerRef.current = node;
  }, []);
  // The editor reports its scroller from effects, and an unmounting editor's
  // cleanup runs after the preview has attached its own: clearing the shared
  // ref then left the preview without a scroller, so switching back to it
  // lost the reading position. Only the editor's own node is cleared.
  const editorScrollerRef = useRef<HTMLElement | null>(null);
  const setEditorScrollerNode = useCallback(
    (node: HTMLElement | null) => {
      if (node) {
        editorScrollerRef.current = node;
        setScrollerNode(node);
        return;
      }
      if (scrollerRef.current === editorScrollerRef.current) setScrollerNode(null);
      editorScrollerRef.current = null;
    },
    [setScrollerNode],
  );
  useScrollableZoomGestures(scrollerRef, zoom, onZoomChange);
  const [rendered, setRendered] = useState<RenderedDocument | null>(null);
  const markdownBodyRef = useRef<HTMLDivElement | null>(null);
  // A mode switch hands the reading position over as a source line: the
  // preview and the editor lay the same text out at different heights, so
  // the shared pixel scrollTop landed in another section.
  const sourceLineHandoffRef = useRef<number | null>(null);
  const editorSourceLineReaderRef = useRef<(() => number | null) | null>(null);
  // The scrollTop prop when a handoff placed the preview: it is the editor's
  // pixels until the preview's own scroll report replaces it.
  const handedOffScrollTopRef = useRef<number | null>(null);
  const markdownMode: MarkdownViewMode =
    kind === "markdown" ? markdownModeProp : "preview";
  const shouldRenderDocument = kind === "html" || markdownMode === "preview";
  const resolvedDocumentId = useMemo(
    () => documentId ?? `${kind}:${title}:${sourcePath ?? ""}:${text.length}`,
    [documentId, kind, sourcePath, text.length, title],
  );
  const [htmlRefreshKey, setHtmlRefreshKey] = useState(0);
  const { report: reportMarkdownScroll } =
    useDebouncedScrollTopChange(onScrollTopChange);
  const [remoteImageDecision, setRemoteImageDecision] = useState({
    documentId: "",
    allow: false,
    dismissed: false,
  });
  const allowRemoteImages =
    remoteImageDecision.documentId === resolvedDocumentId &&
    remoteImageDecision.allow;
  const dismissedRemotePrompt =
    remoteImageDecision.documentId === resolvedDocumentId &&
    remoteImageDecision.dismissed;
  const shouldLoadRemoteImages =
    remoteImagePolicy === "always" ||
    (remoteImagePolicy === "ask" && allowRemoteImages);
  const resourceKey = [
    shouldLoadRemoteImages ? "remote" : "no-remote",
    sourcePath ?? "",
  ].join("|");
  const loading =
    shouldRenderDocument &&
    (!rendered ||
      rendered.kind !== kind ||
      rendered.text !== text ||
      rendered.resourceKey !== resourceKey);
  const html = !loading && rendered ? rendered.html : "";
  // React 19 compares this prop by identity, not by the string: a fresh
  // object each render rewrote the whole document's innerHTML on every
  // re-render (scroll reports included), reparsing megabytes of HTML and
  // wiping the code highlighting and any selection in the preview.
  const bodyHtml = useMemo(() => ({ __html: html }), [html]);
  const error = !loading && rendered ? rendered.error : null;
  const imageSummary = !loading && rendered ? rendered.imageSummary : null;
  const showRemoteImagePrompt =
    remoteImagePolicy === "ask" &&
    !shouldLoadRemoteImages &&
    !loading &&
    !error &&
    (imageSummary?.blockedRemoteImages ?? 0) > 0 &&
    !dismissedRemotePrompt;
  // Code blocks render plain and pick up their highlighting as they near
  // the viewport, so a long document appears as fast as it did unhighlighted.
  // Fetch the editor while the reader is reading, so the first Edit click
  // renders it without suspending.
  const canEdit = Boolean(onMarkdownModeChange);
  useEffect(() => {
    if (kind !== "markdown" || !canEdit) return;
    const preload = () => void loadMarkdownLiveEditor().catch(() => undefined);
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(preload, { timeout: 2000 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(preload, 300);
    return () => window.clearTimeout(handle);
  }, [canEdit, kind]);

  // Chosen once per entry into edit mode: switching the element type under a
  // mounted editor would remount it and lose its selection and history.
  const MarkdownLiveEditor = useMemo(
    () =>
      markdownMode === "edit"
        ? (loadedMarkdownLiveEditor ?? LazyMarkdownLiveEditor)
        : LazyMarkdownLiveEditor,
    [markdownMode],
  );

  // The body remounts on every switch back from the editor with the same
  // html, so the mode is a dependency too.
  useEffect(() => {
    const body = markdownBodyRef.current;
    if (kind !== "markdown" || markdownMode !== "preview" || !html || !body) return;
    return highlightCodeBlocksNearView(body);
  }, [html, kind, markdownMode]);
  const showLinkOpenFailed = useCallback(() => {
    toast.error(t("toast.linkOpenFailed"));
  }, [t]);

  useEffect(() => {
    if (!shouldRenderDocument) return;
    let cancelled = false;
    void renderHtml(kind, text)
      .then((next) =>
        resolveDocumentImageResources(next, {
          allowRemoteImages: shouldLoadRemoteImages,
          documentPath: sourcePath,
          readLocalImage,
        }),
      )
      .then((next) => {
        if (cancelled) return;
        setRendered({
          kind,
          text,
          resourceKey,
          html: next.html,
          imageSummary: next.summary,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setRendered({
          kind,
          text,
          resourceKey,
          html: "",
          imageSummary: {
            remoteImages: 0,
            blockedRemoteImages: 0,
            localImages: 0,
            failedLocalImages: 0,
          },
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    kind,
    readLocalImage,
    renderHtml,
    resourceKey,
    shouldRenderDocument,
    shouldLoadRemoteImages,
    sourcePath,
    text,
  ]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const body = markdownBodyRef.current;
    const handoff = sourceLineHandoffRef.current;
    if (handoff !== null && markdownMode === "preview") {
      if (body && html && scrollPreviewToSourceLine(node, body, handoff)) {
        sourceLineHandoffRef.current = null;
        handedOffScrollTopRef.current = scrollTop;
      }
      return;
    }
    if (handedOffScrollTopRef.current === scrollTop) return;
    handedOffScrollTopRef.current = null;
    if (Math.abs(node.scrollTop - scrollTop) > 1) {
      node.scrollTop = scrollTop;
    }
  }, [html, markdownMode, scrollTop]);

  const openLink = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!isElementTarget(target)) return;
    const action = documentLinkAction(target);
    if (!action) return;
    event.preventDefault();
    if (action.kind !== "external") return;
    void openExternalUrl(action.url).catch(() => {
      showLinkOpenFailed();
    });
  }, [showLinkOpenFailed]);

  if (kind === "html") {
    return (
      <HtmlDocumentView
        title={title}
        documentId={resolvedDocumentId}
        html={html}
        rawText={text}
        loading={loading}
        error={error}
        errorMessage={error ? t("documents.renderFailed", { message: error }) : ""}
        scrollTop={scrollTop}
        onScrollTopChange={onScrollTopChange}
        zoom={zoom}
        imageNotice={
          showRemoteImagePrompt ? (
            <RemoteImageNotice
              count={imageSummary?.blockedRemoteImages ?? 0}
              onLoad={() =>
                setRemoteImageDecision({
                  documentId: resolvedDocumentId,
                  allow: true,
                  dismissed: false,
                })
              }
              onDismiss={() =>
                setRemoteImageDecision({
                  documentId: resolvedDocumentId,
                  allow: false,
                  dismissed: true,
                })
              }
            />
          ) : null
        }
        toolbar={toolbar}
        onZoomChange={onZoomChange}
        refreshKey={htmlRefreshKey}
        onRefresh={() => setHtmlRefreshKey((key) => key + 1)}
        onLinkOpenFailed={showLinkOpenFailed}
      />
    );
  }

  const changeMarkdownMode = (mode: MarkdownViewMode) => {
    if (mode !== markdownMode) {
      const scroller = scrollerRef.current;
      const body = markdownBodyRef.current;
      // The position is a nicety; a view that cannot measure (not laid out)
      // must never stop the switch itself.
      try {
        sourceLineHandoffRef.current =
          markdownMode === "preview"
            ? scroller && body
              ? previewSourceLine(scroller, body)
              : null
            : (editorSourceLineReaderRef.current?.() ?? null);
      } catch {
        sourceLineHandoffRef.current = null;
      }
    }
    onMarkdownModeChange?.(mode);
  };
  const modeToggle = onMarkdownModeChange ? (
    <MarkdownModeToggle mode={markdownMode} onChange={changeMarkdownMode} />
  ) : null;

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
        leading={
          markdownMode === "preview" && showRemoteImagePrompt ? (
            <RemoteImageNotice
              count={imageSummary?.blockedRemoteImages ?? 0}
              onLoad={() =>
                setRemoteImageDecision({
                  documentId: resolvedDocumentId,
                  allow: true,
                  dismissed: false,
                })
              }
              onDismiss={() =>
                setRemoteImageDecision({
                  documentId: resolvedDocumentId,
                  allow: false,
                  dismissed: true,
                })
              }
            />
          ) : null
        }
        trailing={
          modeToggle || toolbar ? (
            <>
              {modeToggle}
              {toolbar}
            </>
          ) : null
        }
      />
      {markdownMode === "edit" ? (
        <Suspense
          fallback={<MarkdownEditorLoading label={t("documents.loading")} />}
        >
          <MarkdownLiveEditor
            documentId={documentId}
            title={t("documents.markdownEditorLabel")}
            metadataEditLabel={t("documents.editMarkdownMetadata")}
            text={text}
            zoom={zoom}
            appearance={markdownAppearance}
            headingColor={markdownHeadingColor}
            scrollTop={scrollTop}
            onScrollTopChange={reportMarkdownScroll}
            onScrollerMount={setEditorScrollerNode}
            onTextChange={onMarkdownTextChange}
            sourceLineHandoffRef={sourceLineHandoffRef}
            sourceLineReaderRef={editorSourceLineReaderRef}
          />
        </Suspense>
      ) : (
        <div
          ref={setScrollerNode}
          onScroll={(event) => reportMarkdownScroll(event.currentTarget.scrollTop)}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            background: T.paper,
            color: T.ink,
          }}
        >
          <article
            className="shioriDocumentViewer"
            aria-label={title}
            onClick={openLink}
            style={{
              // CSS `zoom` scales the rendered content and reflows it within the
              // column (unlike transform: scale, which would force horizontal
              // scroll), so text simply gets bigger/smaller as you'd expect.
              zoom: zoom === 1 ? undefined : zoom,
              boxSizing: "border-box",
              width: "calc(100% - 32px)",
              maxWidth: markdownAppearance.contentWidth,
              margin: "0 auto",
              padding: "clamp(28px, 5vw, 72px) clamp(20px, 5vw, 56px) 96px",
              fontFamily: markdownFontFamilyCss(
                markdownAppearance.bodyFont,
                "body",
              ),
              fontSize: markdownAppearance.fontSize,
              lineHeight: markdownAppearance.lineHeight,
              "--shiori-markdown-code-font": markdownFontFamilyCss(
                markdownAppearance.codeFont,
                "code",
              ),
              "--shiori-markdown-heading-color": markdownHeadingColor,
            } as CSSProperties}
          >
            {error ? (
              <RenderError message={t("documents.renderFailed", { message: error })} />
            ) : loading ? (
              <LoadingBlock />
            ) : (
              <div ref={markdownBodyRef} dangerouslySetInnerHTML={bodyHtml} />
            )}
          </article>
        </div>
      )}
    </div>
  );
}
