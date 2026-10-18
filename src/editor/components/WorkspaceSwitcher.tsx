import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { getRecent, recentEntryKey } from "../recentDocs";
import {
  documentKindShortLabel,
  type DocumentKind,
} from "../../documents/types";

/**
 * The Cmd+Tab of the workspace (bound to Ctrl+Tab — Cmd+Tab belongs to the
 * OS): hold Ctrl and tap Tab to cycle the most recent documents, release
 * Ctrl to land. Ninety percent of switches during comparative reading are
 * between two documents, so one tap goes back to the previous one.
 *
 * Deliberately capped at the six most recent: past that the workspace tree
 * is the right tool, and stuffing more in here would just rebuild the
 * unreadable tab strip in fancier clothes.
 */
export type WorkspaceSwitcherItem = {
  id: string;
  title: string;
  kind: DocumentKind;
  /** recentDocs key used to resolve a cached page-1 thumbnail on open. */
  thumbKey: string;
  /** 1-based page the reader was last on, PDF tabs only. */
  pageNumber?: number;
};

const MAX_ITEMS = 6;

function WorkspaceSwitcherComponent({
  items,
  onCommit,
}: {
  /** MRU order, active document first. The component caps at six. */
  items: WorkspaceSwitcherItem[];
  onCommit: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(1);
  const [thumbs, setThumbs] = useState<ReadonlyMap<string, string>>(new Map());
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const latest = useRef({ items, onCommit, open, index });
  useEffect(() => {
    latest.current = { items, onCommit, open, index };
  });

  useEffect(() => {
    const shown = () => latest.current.items.slice(0, MAX_ITEMS);
    const commit = () => {
      const picked = shown()[latest.current.index];
      setOpen(false);
      if (picked) latest.current.onCommit(picked.id);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const state = latest.current;
      if (event.key === "Tab" && event.ctrlKey) {
        // The embedded terminal owns its keyboard entirely while focused —
        // an agent session may bind anything, and a hijacked Tab there
        // would be indistinguishable from a broken shell.
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest(".xterm")) return;
        const count = Math.min(state.items.length, MAX_ITEMS);
        if (count < 2) return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? -1 : 1;
        if (!state.open) {
          setThumbs(
            new Map(
              getRecent().flatMap((entry) =>
                entry.thumb ? [[recentEntryKey(entry), entry.thumb]] : [],
              ),
            ),
          );
          setIndex((count + step) % count);
          setOpen(true);
        } else {
          setIndex((state.index + step + count) % count);
        }
        return;
      }
      if (!state.open) return;
      const count = Math.min(state.items.length, MAX_ITEMS);
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const step = event.key === "ArrowRight" ? 1 : -1;
        setIndex((state.index + step + count) % count);
      } else if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control" && latest.current.open) commit();
    };
    // Losing window focus mid-chord (Cmd+Tab to another app) must not leave
    // the overlay stranded with no Ctrl keyup ever arriving.
    const onBlur = () => setOpen(false);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    listboxRef.current?.focus({ preventScroll: true });
    return () => {
      previousFocusRef.current?.focus({ preventScroll: true });
      previousFocusRef.current = null;
    };
  }, [open]);

  if (!open) return null;
  const shown = items.slice(0, MAX_ITEMS);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("nav.switcherLabel")}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        display: "grid",
        placeItems: "center",
        background: "rgba(20, 16, 10, 0.34)",
        backdropFilter: "blur(6px)",
      }}
      onPointerDown={() => setOpen(false)}
    >
      <div
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          background: T.cream,
          border: `1px solid ${T.rule}`,
          borderRadius: 14,
          padding: "16px 16px 12px",
          boxShadow: "0 24px 64px -28px rgba(20,16,10,0.5)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          maxWidth: "min(92vw, 760px)",
        }}
      >
        <div
          ref={listboxRef}
          role="listbox"
          tabIndex={0}
          aria-label={t("nav.switcherLabel")}
          aria-activedescendant={`shiori-switcher-option-${index}`}
          style={{
            display: "flex",
            gap: 10,
            overflowX: "auto",
            padding: 2,
            outline: "none",
          }}
        >
          {shown.map((item, i) => (
            <button
              key={item.id}
              id={`shiori-switcher-option-${i}`}
              type="button"
              role="option"
              aria-selected={i === index}
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                onCommit(item.id);
              }}
              style={{
                appearance: "none",
                border: "none",
                background: i === index ? T.accentSoft : "transparent",
                borderRadius: 10,
                padding: 6,
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                width: 112,
                flex: "none",
                transform: i === index ? "translateY(-2px)" : undefined,
                transition: "background 120ms linear, transform 120ms ease",
              }}
            >
              <span
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: "100%",
                  aspectRatio: "17 / 22",
                  background: T.paper,
                  border: `1px solid ${i === index ? T.accent : T.rule}`,
                  boxShadow: i === index ? `0 0 0 2px ${T.accent}` : undefined,
                  borderRadius: 3,
                  overflow: "hidden",
                }}
              >
                {thumbs.get(item.thumbKey) ? (
                  <img
                    src={thumbs.get(item.thumbKey)}
                    alt=""
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      objectPosition: "top",
                    }}
                  />
                ) : (
                  <span
                    style={{
                      font: `600 11px/1 ${T.mono}`,
                      letterSpacing: "0.06em",
                      color: T.dim,
                      textTransform: "uppercase",
                    }}
                  >
                    {documentKindShortLabel(item.kind)}
                  </span>
                )}
              </span>
              <span
                dir="auto"
                style={{
                  font: `500 11.5px/1.35 ${T.sans}`,
                  color: i === index ? T.accentText : T.ink2,
                  textAlign: "left",
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  wordBreak: "break-word",
                }}
              >
                {item.title}
                {item.pageNumber ? (
                  <span
                    style={{
                      display: "block",
                      font: `400 9.5px/1.5 ${T.mono}`,
                      color: T.dim,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {t("documentTree.page", { page: item.pageNumber })}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
        <div
          style={{
            font: `400 10.5px/1.4 ${T.sans}`,
            color: T.dim,
            textAlign: "center",
          }}
        >
          {t("nav.switcherHint")}
        </div>
      </div>
    </div>
  );
}

export const WorkspaceSwitcher = memo(WorkspaceSwitcherComponent);
