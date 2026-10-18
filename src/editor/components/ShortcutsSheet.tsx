import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Kbd, Modal } from "./ui";
import { k } from "../../platform/keys";

type Props = {
  open: boolean;
  onClose: () => void;
};

type RowKey =
  | "select"
  | "markup"
  | "ink"
  | "callout"
  | "signature"
  | "stamp"
  | "rect"
  | "text"
  | "undo"
  | "redo"
  | "deleteSel"
  | "copy"
  | "paste"
  | "duplicate"
  | "selectAll"
  | "nudge"
  | "rotate"
  | "print"
  | "find"
  | "nextPrev"
  | "goto"
  | "pan"
  | "zoomIn"
  | "zoomOut"
  | "fit"
  | "actual"
  | "readerMode";

const GROUPS: Array<{
  t: "tools" | "edit" | "navigation" | "zoom";
  rows: Array<[string, RowKey]>;
}> = [
  {
    t: "tools",
    rows: [
      ["V", "select"],
      ["H / U / ⇧ U", "markup"],
      ["I", "ink"],
      ["C", "callout"],
      ["G", "signature"],
      ["S", "stamp"],
      ["R", "rect"],
      ["T", "text"],
    ],
  },
  {
    t: "edit",
    rows: [
      ["⌘ Z", "undo"],
      ["⇧ ⌘ Z", "redo"],
      ["⌫", "deleteSel"],
      ["⌘ C", "copy"],
      ["⌘ V", "paste"],
      ["⌘ D", "duplicate"],
      ["⌘ A", "selectAll"],
      ["↑ ↓ ← →", "nudge"],
      ["⇧", "rotate"],
      ["⌘ P", "print"],
      ["⌘ F", "find"],
    ],
  },
  {
    t: "navigation",
    rows: [
      ["J / K", "nextPrev"],
      ["⌘ G", "goto"],
      ["Space", "pan"],
    ],
  },
  {
    t: "zoom",
    rows: [
      ["⌘ +", "zoomIn"],
      ["⌘ −", "zoomOut"],
      ["⌘ 0", "fit"],
      ["⌘ 1", "actual"],
      ["⌘ \\", "readerMode"],
    ],
  },
];

export function ShortcutsSheet({ open, onClose }: Props) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <Modal
      onClose={onClose}
      title={t("shortcuts.title")}
      subtitle={t("shortcuts.subtitle")}
      width={640}
    >
      {/* Multi-column flow auto-balances across two columns so short
          groups don't leave empty space below tall ones. */}
      <div
        style={{
          columnCount: 2,
          columnGap: 28,
          columnFill: "balance",
        }}
      >
        {GROUPS.map((g, gi) => (
          <div
            key={g.t}
            style={{
              breakInside: "avoid",
              pageBreakInside: "avoid",
            }}
          >
            <div
              style={{
                font: `500 11px/1 ${T.mono}`,
                color: T.dim,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                margin: gi === 0 ? "2px 0 6px" : "14px 0 6px",
              }}
            >
              {t(`shortcuts.groups.${g.t}`)}
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {g.rows.map(([keys, rowKey]) => (
                <div
                  key={rowKey}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "5px 0",
                    borderBottom: `1px dashed ${T.ruleSoft}`,
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      font: `13.5px/1.2 ${T.sans}`,
                      color: T.ink2,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t(`shortcuts.rows.${rowKey}`)}
                  </span>
                  <span style={{ display: "flex", gap: 4, flex: "0 0 auto" }}>
                    {k(keys)
                      .split(" ")
                      .map((key, i) => (
                        <Kbd key={i}>{key}</Kbd>
                      ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
