import { useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import type { DocumentTreeAnchor } from "./documentTreeAnchors";
import { RowPreview } from "./RowPreview";

/**
 * Every mark in the active document, in reading order — the navigator's
 * finest scale of "where am I".
 *
 * These used to hang under the document's own row in the documents view. That
 * made one list answer two questions at two scales: seven marks already
 * pushed the second document off the bottom of the panel, and a real reading
 * session has dozens. Marks are a scale of their own, so they get a view of
 * their own; the documents view keeps only their count.
 *
 * Navigation, not editing. Note bodies are still edited in place on the page
 * (and in the right rail's notes list) — a list that both navigates and edits
 * is how the nesting problem starts again.
 *
 * Layout follows Obsidian's file tree: the kind label sits at the RIGHT edge
 * so every body starts in the same column. On the left it stole the width the
 * text needed, which is what made every row end in an ellipsis.
 */
export function MarksList({
  anchors,
  selectedIds,
  onOpen,
}: {
  anchors: DocumentTreeAnchor[];
  selectedIds: readonly string[];
  onOpen: (anchor: DocumentTreeAnchor) => void;
}) {
  const { t } = useTranslation();
  // One preview at a time, opened by pointer or by keyboard focus.
  // The row's measured rect travels with the id: the popover is positioned
  // `fixed`, because the scroll box around these rows clips absolutely
  // positioned children on BOTH axes (see RowPreview).
  const [preview, setPreview] = useState<{ id: string; rect: DOMRect } | null>(
    null,
  );

  if (anchors.length === 0) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <p
          style={{
            margin: "10px 12px",
            font: `400 11.5px/1.5 ${T.sans}`,
            color: T.dim,
          }}
        >
          {t("navigator.marksEmpty")}
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: "2px 0 8px",
      }}
    >
      {anchors.map((anchor, index) => {
        const selected = selectedIds.includes(anchor.id);
        // The page number heads its group instead of repeating on every row.
        // Eight marks on page 1 printed "p1" eight times, which read as the
        // most important thing in the list while saying the least.
        const startsPage =
          index === 0 || anchors[index - 1]?.page !== anchor.page;
        const showPreview = preview?.id === anchor.id;
        return (
          <div key={anchor.id} style={{ position: "relative" }}>
            {startsPage ? (
              <div
                style={{
                  padding: "8px 10px 2px",
                  font: `600 9px/1.4 ${T.mono}`,
                  letterSpacing: ".08em",
                  color: T.dim,
                }}
              >
                {t("documentTree.page", { page: anchor.page })}
              </div>
            ) : null}
            <button
              type="button"
              aria-current={selected}
              aria-describedby={showPreview ? `mark-preview-${anchor.id}` : undefined}
              onClick={() => onOpen(anchor)}
              onMouseEnter={(event) =>
                setPreview({
                  id: anchor.id,
                  rect: event.currentTarget.getBoundingClientRect(),
                })
              }
              onMouseLeave={() =>
                setPreview((current) =>
                  current?.id === anchor.id ? null : current,
                )
              }
              onFocus={(event) =>
                setPreview({
                  id: anchor.id,
                  rect: event.currentTarget.getBoundingClientRect(),
                })
              }
              onBlur={() =>
                setPreview((current) =>
                  current?.id === anchor.id ? null : current,
                )
              }
              style={{
                appearance: "none",
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto",
                alignItems: "baseline",
                gap: 8,
                width: "100%",
                border: "none",
                background: selected
                  ? T.accentSoft
                  : showPreview
                    ? T.paper
                    : "transparent",
                padding: "4px 10px",
                margin: 0,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span
                style={{
                  minWidth: 0,
                  font: `${selected ? 600 : 400} 11.5px/1.5 ${T.sans}`,
                  color: selected ? T.ink : T.ink2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {anchor.label}
              </span>
              {/* Reuses the tool names, so a mark is called in the list
                  exactly what the toolbar calls it. */}
              <span
                style={{
                  font: `500 9px/1.6 ${T.mono}`,
                  color: T.dim,
                  flex: "none",
                }}
              >
                {markKindLabel(anchor.kind, t)}
              </span>
            </button>
            {showPreview && preview ? (
              <RowPreview
                id={`mark-preview-${anchor.id}`}
                anchor={preview.rect}
                heading={[
                  markKindLabel(anchor.kind, t),
                  t("documentTree.page", { page: anchor.page }),
                  anchor.threadTurns
                    ? t("navigator.markThread", { count: anchor.threadTurns })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                body={anchor.preview}
                note={
                  anchor.previewClipped
                    ? t("navigator.markClipped")
                    : undefined
                }
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function markKindLabel(kind: string, t: (key: string) => string): string {
  // contentText is an edit to the document's own words, not an annotation on
  // top of it — the toolbar has no name for it, so the navigator supplies one.
  if (kind === "contentText") return t("navigator.markEditedText");
  return t(`tools.${kind}`);
}
