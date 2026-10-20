import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PageModel } from "../../pdf/model/types";
import { isBlankPage } from "../../pdf/model/types";
import { appPdfEngine } from "../../pdf/engine/appEngine";
import type { PdfDocument } from "../../pdf/engine/types";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import { IconBtn } from "./ui";
import { SearchTextLimitError } from "../search/findMatches";
import {
  findLayoutSearchMatches,
  indexLayoutSearchPages,
  type LayoutSearchPageText,
} from "../search/layoutSearch";
import { pageJumpForOffscreenSearchMatch } from "../search/navigation";
import { isEditableKeyboardTarget } from "./overlays/overlayPointer";
import { useEditorStore } from "../store/store";
import {
  buildSemanticTextLayerModel,
  semanticUnitsToSearchIndex,
} from "../textSelection/semanticText";

type Props = {
  doc: PdfDocument;
  pages: PageModel[];
  open: boolean;
  onClose: () => void;
};

type IndexStatus = "idle" | "loading" | "ready" | "error";

const MAX_FIND_INDEXED_TEXT_CHARACTERS = 10_000_000;

export function FindPanel({ doc, pages, open, onClose }: Props) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const goToPage = useEditorStore((s) => s.goToPage);
  const setSearchMatchHighlight = useEditorStore((s) => s.setSearchMatchHighlight);
  const [query, setQuery] = useState("");
  const [indexedPages, setIndexedPages] = useState<LayoutSearchPageText[]>([]);
  const [loadedCount, setLoadedCount] = useState(0);
  const [status, setStatus] = useState<IndexStatus>("idle");
  const [requestedMatchIndex, setRequestedMatchIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => {
      const el = inputRef.current;
      el?.focus();
      // The query survives close/reopen; select it so typing replaces the
      // old search while Enter still steps through the kept matches.
      el?.select();
    }, 0);
  }, [open]);

  // The text index is a pure function of (doc, pages). It used to rebuild on
  // every reopen, so any panel that force-closes Find (Settings, Export…)
  // emptied the results until a long PDF finished re-extracting. Cache by
  // identity — edits replace the pages array, which invalidates naturally.
  const indexedForRef = useRef<{
    doc: PdfDocument;
    pages: PageModel[];
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    if (
      indexedForRef.current?.doc === doc &&
      indexedForRef.current?.pages === pages
    ) {
      return;
    }
    let cancelled = false;

    (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setStatus("loading");
      setLoadedCount(0);
      setIndexedPages([]);

      const next: LayoutSearchPageText[] = [];
      let indexedCharacters = 0;
      for (let i = 0; i < pages.length; i += 1) {
        const page = pages[i];
        if (!page) continue;
        if (isBlankPage(page)) {
          next.push({
            pageId: page.id,
            pageNumber: i + 1,
            text: "",
          });
          setLoadedCount(i + 1);
          continue;
        }
        const { content } = await appPdfEngine.pageText(doc, page.sourceIndex, {
          textOnly: true,
          checkAbort: () => {
            if (cancelled) throw new Error("Find indexing was cancelled");
          },
        });
        if (cancelled) return;
        // The same text and breaks CLI search and quote anchors match.
        const { text, layoutBreaks, hardBreaks } = semanticUnitsToSearchIndex(
          buildSemanticTextLayerModel(content).units,
        );
        indexedCharacters += text.length;
        if (indexedCharacters > MAX_FIND_INDEXED_TEXT_CHARACTERS) {
          throw new SearchTextLimitError(
            `Document search text exceeds ${MAX_FIND_INDEXED_TEXT_CHARACTERS} characters`,
          );
        }
        next.push({
          pageId: page.id,
          pageNumber: i + 1,
          text,
          layoutBreaks,
          hardBreaks,
        });
        setLoadedCount(i + 1);
      }
      setIndexedPages(next);
      setStatus("ready");
      indexedForRef.current = { doc, pages };
    })().catch((err) => {
      if (cancelled) return;
      console.error("find index failed", err);
      setStatus("error");
    });

    return () => {
      cancelled = true;
    };
  }, [doc, open, pages]);

  const searchIndexResult = useMemo(() => {
    try {
      return { pages: indexLayoutSearchPages(indexedPages), failed: false };
    } catch (error) {
      if (error instanceof SearchTextLimitError) {
        console.error("find search index exceeded safety limits", error);
        return { pages: [], failed: true };
      }
      throw error;
    }
  }, [indexedPages]);
  const matchResult = useMemo(() => {
    if (searchIndexResult.failed) {
      return { matches: [], truncated: false, failed: true };
    }
    try {
      return {
        ...findLayoutSearchMatches(searchIndexResult.pages, query),
        failed: false,
      };
    } catch (error) {
      if (error instanceof SearchTextLimitError) {
        console.error("find query exceeded safety limits", error);
        return { matches: [], truncated: false, failed: true };
      }
      throw error;
    }
  }, [query, searchIndexResult]);
  const matches = matchResult.matches;
  const effectiveStatus: IndexStatus = matchResult.failed ? "error" : status;
  const activeMatchIndex =
    query.trim() && matches.length > 0
      ? Math.min(requestedMatchIndex, matches.length - 1)
      : -1;

  useEffect(() => {
    if (!open || !query.trim() || activeMatchIndex < 0) {
      setSearchMatchHighlight(null);
      return;
    }
    const match = matches[activeMatchIndex];
    if (!match) {
      setSearchMatchHighlight(null);
      return;
    }
    const pageJump = pageJumpForOffscreenSearchMatch(match, pages);
    if (pageJump) {
      goToPage(pageJump.pageId, pageJump.index);
    }
    setSearchMatchHighlight({
      pageId: match.pageId,
      charStart: match.index,
      charEnd: match.end,
    });
  }, [
    activeMatchIndex,
    goToPage,
    matches,
    open,
    pages,
    query,
    setSearchMatchHighlight,
  ]);

  useEffect(
    () => () => {
      setSearchMatchHighlight(null);
    },
    [setSearchMatchHighlight],
  );

  const go = useCallback(
    (delta: -1 | 1) => {
      if (matches.length === 0) return;
      setRequestedMatchIndex((current) => {
        const base = current < 0 ? 0 : current;
        return (base + delta + matches.length) % matches.length;
      });
    },
    [matches.length],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        // A dialog stacked above the panel owns Escape; the Modal shell marks
        // itself with this attribute and runs its own handler.
        if (document.querySelector("[data-shiori-modal-open]")) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // Arrow keys belong to whatever is being typed in. Without this guard,
      // editing a text annotation while the find panel was open meant Up/Down
      // moved the search selection and scrolled the page away instead of
      // moving the caret. The find field itself is exempt — stepping through
      // matches with the arrows is the point of it.
      const inField = e.target === inputRef.current;
      if (!inField && isEditableKeyboardTarget(e.target)) return;

      if (mod && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        // Canvas binds Cmd/Ctrl+G to Go To Page. Both listeners fired, so
        // pressing it while searching jumped matches AND opened the dialog,
        // closing the find panel and losing the position.
        e.stopPropagation();
        go(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "F3") {
        e.preventDefault();
        e.stopPropagation();
        go(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        go(e.key === "ArrowUp" ? -1 : 1);
      }
    };
    // CAPTURE phase, deliberately. Canvas binds its own window keydown in the
    // bubble phase and registered first, so neither preventDefault nor
    // stopImmediatePropagation from a bubble-phase listener here could stop it
    // — both listeners simply ran. Capturing on window happens before any
    // bubble-phase listener on window, so stopPropagation here really does
    // keep the event from reaching it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, go]);

  if (!open) return null;

  const activeMatch = activeMatchIndex >= 0 ? matches[activeMatchIndex] : null;
  const statusText = buildStatusText(
    t,
    effectiveStatus,
    query,
    loadedCount,
    pages.length,
    matchResult.truncated ? `${matches.length}+` : matches.length,
    activeMatchIndex,
  );
  const counterText = activeMatch
    ? t("find.count", {
        current: activeMatchIndex + 1,
        total: matchResult.truncated ? `${matches.length}+` : matches.length,
      })
    : null;

  return (
    <div
      className="shioriPrintHide"
      style={{
        position: "fixed",
        top: "calc(58px + var(--shiori-safe-top, 0px))",
        right: "calc(18px + var(--shiori-safe-right, 0px))",
        width:
          "min(420px, calc(100vw - 36px - var(--shiori-safe-left, 0px) - var(--shiori-safe-right, 0px)))",
        zIndex: 35,
        background: T.cream,
        border: `1px solid ${T.rule}`,
        borderRadius: 4,
        boxShadow:
          "0 18px 48px rgba(20,16,10,0.18), 0 1px 3px rgba(20,16,10,0.08)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: 10,
          borderBottom: `1px solid ${T.ruleSoft}`,
        }}
      >
        <Ic.search />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setRequestedMatchIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter") {
              e.preventDefault();
              go(e.shiftKey ? -1 : 1);
            }
          }}
          placeholder={t("find.placeholder")}
          style={{
            flex: 1,
            minWidth: 0,
            height: 30,
            border: `1px solid ${T.rule}`,
            borderRadius: 4,
            background: T.surface,
            color: T.ink,
            padding: "0 9px",
            outline: "none",
            font: `13px/1 ${T.sans}`,
          }}
        />
        {counterText ? (
          <span
            style={{
              font: `500 11px/1 ${T.mono}`,
              color: T.dim,
              whiteSpace: "nowrap",
            }}
          >
            {counterText}
          </span>
        ) : null}
        <IconBtn
          title={t("find.previous")}
          onClick={() => go(-1)}
          disabled={matches.length === 0}
        >
          <Ic.chev style={{ transform: "rotate(-90deg)" }} />
        </IconBtn>
        <IconBtn
          title={t("find.next")}
          onClick={() => go(1)}
          disabled={matches.length === 0}
        >
          <Ic.chev style={{ transform: "rotate(90deg)" }} />
        </IconBtn>
        <IconBtn title={t("find.close")} onClick={onClose}>
          <Ic.x />
        </IconBtn>
      </div>
      <div style={{ padding: "9px 12px 11px" }}>
        {activeMatch ? (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              color: T.ink2,
              font: `12.5px/1.45 ${T.sans}`,
            }}
          >
            <span
              style={{
                flex: "0 0 auto",
                border: `1px solid ${T.ruleSoft}`,
                borderRadius: 999,
                color: T.dim,
                background: T.surface,
                padding: "2px 6px",
                font: `500 10.5px/1.2 ${T.mono}`,
                whiteSpace: "nowrap",
              }}
            >
              {t("find.pageShort", { page: activeMatch.pageNumber })}
            </span>
            <span
              style={{
                minWidth: 0,
                overflowWrap: "break-word",
              }}
            >
              {activeMatch.snippet.before}
              <span style={{ color: T.accentText, fontWeight: 700 }}>
                {activeMatch.snippet.match}
              </span>
              {activeMatch.snippet.after}
            </span>
          </div>
        ) : (
          <div
            style={{
              font: `500 11px/1 ${T.mono}`,
              letterSpacing: ".04em",
              textTransform: "uppercase",
              color: effectiveStatus === "error" ? T.rect : T.dim,
            }}
          >
            {statusText}
          </div>
        )}
      </div>
    </div>
  );
}

function buildStatusText(
  t: (key: string, vars?: Record<string, unknown>) => string,
  status: IndexStatus,
  query: string,
  loaded: number,
  totalPages: number,
  totalMatches: number | string,
  activeIndex: number,
): string {
  if (status === "loading") {
    return t("find.loading", { loaded, total: totalPages });
  }
  if (status === "error") return t("find.error");
  if (!query.trim()) return t("find.empty");
  if (totalMatches === 0) return t("find.noMatches");
  return t("find.count", {
    current: activeIndex + 1,
    total: totalMatches,
  });
}
