import {
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import { useEditorStore } from "../store/store";
import { appPdfEngine } from "../../pdf/engine/appEngine";
import type {
  PdfDestination,
  PdfDocument,
  PdfOutlineItem,
} from "../../pdf/engine/types";
import { destinationDisplayY, destinationPdfTop } from "./Canvas";

/**
 * The PDF's own table of contents. It used to be the right rail's first tab,
 * next to the terminal and the browser — which put "where am I in this
 * document" beside "what am I running", two questions that have nothing to do
 * with each other. It lives in the left navigator now, with the other
 * answers to the same question.
 *
 * Still reachable from the right rail on mobile, which has no gutter for a
 * navigator; the components below are shared by both.
 */

export type OutlineNode = {
  title: string;
  pageIndex: number | null;
  dest: PdfDestination | null;
  children: OutlineNode[];
};

const VISUALLY_HIDDEN = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
} satisfies CSSProperties;

type OutlineTooltipAnchor = Pick<DOMRect, "left" | "top" | "bottom">;

function placeOutlineTooltip(anchor: OutlineTooltipAnchor): CSSProperties {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(300, Math.max(180, viewportWidth - 24));
  const left = Math.max(12, Math.min(anchor.left + 40, viewportWidth - width - 12));
  const roomBelow = viewportHeight - anchor.bottom;
  return {
    position: "fixed",
    left,
    width,
    maxWidth: "calc(100vw - 24px)",
    ...(roomBelow >= 72
      ? { top: anchor.bottom + 6 }
      : { bottom: viewportHeight - anchor.top + 6 }),
  };
}

/** Owns loading, collapse state and navigation for one document's outline. */
export function OutlinePanel({ doc }: { doc: PdfDocument | null }) {
  const pages = useEditorStore((s) => s.model.pages);
  const activePageId = useEditorStore((s) => s.activePageId);
  const goToPage = useEditorStore((s) => s.goToPage);
  const scale = useEditorStore((s) => s.scale);
  const setOutlineSelection = useEditorStore((s) => s.setOutlineSelection);
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  const [lastClickedOutlineKey, setLastClickedOutlineKey] = useState<
    string | null
  >(null);
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const outlineScopeKey = doc
    ? `${appPdfEngine.pageCount(doc)}:${pages[0]?.id ?? "none"}`
    : "none";
  const visibleOutline = useMemo(
    () => (outline ? outlineForAvailablePages(outline, pages) : outline),
    [outline, pages],
  );

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      try {
        const items = await appPdfEngine.outline(doc);
        if (!cancelled) setOutline(outlineNodes(items));
      } catch {
        if (!cancelled) setOutline([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  const toggleCollapse = (itemKey: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(itemKey)) next.delete(itemKey);
      else next.add(itemKey);
      return next;
    });
  };

  const gotoOutlineNode = async (node: OutlineNode) => {
    if (!doc || node.pageIndex == null) {
      setOutlineSelection(null);
      return;
    }
    const index = pages.findIndex((p) => p.sourceIndex === node.pageIndex);
    const page = index >= 0 ? pages[index] : null;
    if (!page) {
      setOutlineSelection(null);
      return;
    }
    const fallback = () => {
      setOutlineSelection(null);
      goToPage(page.id, index);
    };
    if (!node.dest) {
      fallback();
      return;
    }
    // Store the highlight anchor in PDF user space so it stays aligned
    // across zoom changes; the one-time scroll still uses a display
    // offset computed at the current scale.
    const pdfTop = destinationPdfTop(node.dest, page);
    if (pdfTop == null) {
      fallback();
      return;
    }
    setOutlineSelection({ pageId: page.id, pdfTop });
    goToPage(page.id, index, destinationDisplayY(node.dest, page, scale));
  };

  return (
    <OutlineList
      outline={visibleOutline}
      onGo={gotoOutlineNode}
      activePageId={activePageId}
      pages={pages}
      lastClickedOutlineKey={lastClickedOutlineKey}
      onSelectKey={setLastClickedOutlineKey}
      outlineScopeKey={outlineScopeKey}
      collapsedKeys={collapsedKeys}
      onToggleCollapse={toggleCollapse}
    />
  );
}

function OutlineList({
  outline,
  onGo,
  activePageId,
  pages,
  lastClickedOutlineKey,
  onSelectKey,
  outlineScopeKey,
  collapsedKeys,
  onToggleCollapse,
}: {
  outline: OutlineNode[] | null;
  onGo: (node: OutlineNode) => void | Promise<void>;
  activePageId: string | null;
  pages: { id: string; sourceIndex: number }[];
  lastClickedOutlineKey: string | null;
  onSelectKey: (key: string) => void;
  outlineScopeKey: string;
  collapsedKeys: Set<string>;
  onToggleCollapse: (key: string) => void;
}) {
  const { t } = useTranslation();
  const hasClickedOutlineSelection =
    lastClickedOutlineKey?.startsWith(`${outlineScopeKey}:outline:`) ?? false;
  if (outline === null) {
    return (
      <div
        style={{
          padding: "14px 14px",
          color: T.dim,
          font: `12.5px/1.5 ${T.sans}`,
        }}
      >
        {t("rail.outlineLoading")}
      </div>
    );
  }
  if (outline.length === 0) {
    return (
      <div
        style={{
          padding: "14px 14px",
          color: T.dim,
          font: `12.5px/1.5 ${T.sans}`,
        }}
      >
        {t("rail.outlineEmpty")}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {outline.map((s, i) => (
        <OutlineBranch
          key={`${s.title}-${i}`}
          node={s}
          depth={0}
          onGo={onGo}
          activePageId={activePageId}
          pages={pages}
          number={String(i + 1)}
          itemKey={`${outlineScopeKey}:outline:${i + 1}`}
          lastClickedOutlineKey={lastClickedOutlineKey}
          hasClickedOutlineSelection={hasClickedOutlineSelection}
          onSelectKey={onSelectKey}
          collapsedKeys={collapsedKeys}
          onToggleCollapse={onToggleCollapse}
        />
      ))}
    </div>
  );
}

function OutlineBranch({
  node,
  depth,
  onGo,
  activePageId,
  pages,
  number,
  itemKey,
  lastClickedOutlineKey,
  hasClickedOutlineSelection,
  onSelectKey,
  collapsedKeys,
  onToggleCollapse,
}: {
  node: OutlineNode;
  depth: number;
  onGo: (node: OutlineNode) => void | Promise<void>;
  activePageId: string | null;
  pages: { id: string; sourceIndex: number }[];
  number: string;
  itemKey: string;
  lastClickedOutlineKey: string | null;
  hasClickedOutlineSelection: boolean;
  onSelectKey: (key: string) => void;
  collapsedKeys: Set<string>;
  onToggleCollapse: (key: string) => void;
}) {
  const { t } = useTranslation();
  const staleTooltipId = useId();
  const [staleTooltipAnchor, setStaleTooltipAnchor] =
    useState<OutlineTooltipAnchor | null>(null);
  const activeSourceIdx = pages.find((p) => p.id === activePageId)?.sourceIndex ?? -1;
  const active =
    !hasClickedOutlineSelection &&
    node.pageIndex != null &&
    node.pageIndex === activeSourceIdx;
  const clicked = itemKey === lastClickedOutlineKey;
  const hasChildren = node.children.length > 0;
  const collapsed = collapsedKeys.has(itemKey);
  const canGo = node.pageIndex != null;
  const staleDestination = node.dest != null && !canGo;
  const labelStyle = {
    appearance: "none",
    border: "none",
    padding: "6px 0",
    margin: 0,
    background: "transparent",
    cursor: staleDestination ? "help" : canGo ? "pointer" : "default",
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    flex: 1,
    minWidth: 0,
    textAlign: "left",
    opacity: staleDestination ? 0.55 : 1,
  } satisfies CSSProperties;
  const label = (
    <>
      <span
        style={{
          font: `500 11px/1.4 ${T.mono}`,
          color: clicked ? T.accentText : T.dim,
          fontVariantNumeric: "tabular-nums",
          minWidth: 22,
        }}
      >
        {number}
      </span>
      <span
        style={{
          flex: 1,
          font: `${clicked || active ? 500 : 400} 13.5px/1.35 ${T.sans}`,
          color: clicked || active ? T.ink : T.ink2,
          textDecoration: staleDestination ? "underline dotted" : undefined,
          textUnderlineOffset: staleDestination ? 3 : undefined,
        }}
      >
        {node.title}
      </span>
    </>
  );
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: `0 14px 0 ${4 + depth * 16}px`,
          background: clicked ? T.accentGhost : active ? T.paper : "transparent",
          borderLeft: clicked
            ? `2px solid ${T.accent}`
            : active
              ? `2px solid ${T.ink}`
              : `2px solid transparent`,
          cursor: canGo ? "pointer" : "default",
        }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => {
              onToggleCollapse(itemKey);
            }}
            // Hardcoded literal on every outline row: zh/ja users saw English,
            // and it is the only name a screen reader has for this control.
            title={
              collapsed ? t("rail.outlineExpand") : t("rail.outlineCollapse")
            }
            aria-label={
              collapsed ? t("rail.outlineExpand") : t("rail.outlineCollapse")
            }
            aria-expanded={!collapsed}
            style={{
              width: 18,
              height: 18,
              padding: 0,
              border: "none",
              background: "transparent",
              color: T.dim,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 3,
              flexShrink: 0,
              transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
              transition: "transform 120ms ease",
            }}
          >
            <Ic.chev />
          </button>
        ) : (
          <span style={{ width: 18, flexShrink: 0 }} />
        )}
        {canGo ? (
          <button
            type="button"
            aria-current={clicked || active ? "location" : undefined}
            onClick={() => {
              onSelectKey(itemKey);
              void onGo(node);
            }}
            style={labelStyle}
          >
            {label}
          </button>
        ) : (
          <div
            style={labelStyle}
            role={staleDestination ? "link" : undefined}
            tabIndex={staleDestination ? 0 : undefined}
            aria-disabled={staleDestination ? "true" : undefined}
            aria-describedby={
              staleDestination ? staleTooltipId : undefined
            }
            onMouseEnter={(event) => {
              if (staleDestination) {
                setStaleTooltipAnchor(
                  event.currentTarget.getBoundingClientRect(),
                );
              }
            }}
            onMouseLeave={() => setStaleTooltipAnchor(null)}
            onFocus={(event) => {
              if (staleDestination) {
                setStaleTooltipAnchor(
                  event.currentTarget.getBoundingClientRect(),
                );
              }
            }}
            onBlur={() => setStaleTooltipAnchor(null)}
          >
            {label}
          </div>
        )}
      </div>
      {staleDestination ? (
        <div
          id={staleTooltipId}
          role="tooltip"
          style={
            staleTooltipAnchor
              ? {
                  ...placeOutlineTooltip(staleTooltipAnchor),
                  zIndex: 80,
                  padding: "8px 10px",
                  background: T.surface,
                  border: `1px solid ${T.rule}`,
                  borderRadius: 7,
                  boxShadow:
                    "0 12px 30px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)",
                  color: T.ink,
                  font: `500 12px/1.45 ${T.sans}`,
                  pointerEvents: "none",
                }
              : VISUALLY_HIDDEN
          }
        >
          {t("rail.outlineTargetMissing")}
        </div>
      ) : null}
      {!collapsed &&
        node.children.map((c, i) => (
          <OutlineBranch
            key={`${c.title}-${i}`}
            node={c}
            depth={depth + 1}
            onGo={onGo}
            activePageId={activePageId}
            pages={pages}
            number={`${number}.${i + 1}`}
            itemKey={`${itemKey}.${i + 1}`}
            lastClickedOutlineKey={lastClickedOutlineKey}
            hasClickedOutlineSelection={hasClickedOutlineSelection}
            onSelectKey={onSelectKey}
            collapsedKeys={collapsedKeys}
            onToggleCollapse={onToggleCollapse}
          />
        ))}
    </>
  );
}


function outlineNodes(items: PdfOutlineItem[]): OutlineNode[] {
  return items.map((item) => ({
    title: item.title,
    pageIndex: item.destination?.pageIndex ?? null,
    dest: item.destination,
    children: outlineNodes(item.children),
  }));
}

function outlineForAvailablePages(
  items: OutlineNode[],
  pages: { sourceIndex: number }[],
): OutlineNode[] {
  const available = new Set(pages.map((page) => page.sourceIndex));
  const filter = (nodes: OutlineNode[]): OutlineNode[] =>
    nodes.map((node) => {
      const children = filter(node.children);
      const pageIndex =
        node.pageIndex != null && available.has(node.pageIndex)
          ? node.pageIndex
          : null;
      // Preserve the PDF's title hierarchy, but remove the interactive
      // affordance when its destination no longer exists in the current model.
      return { ...node, pageIndex, children };
    });
  return filter(items);
}
