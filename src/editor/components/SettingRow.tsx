import { T } from "../../design/tokens";
import { useIsMobile } from "../hooks/useIsMobile";

// One labelled row in Settings: name and hint on the left, the control on
// the right (stacked under the label on phones when `block` is set).
export function SettingRow({
  name,
  hint,
  children,
  block,
}: {
  name: string;
  hint?: string;
  children: React.ReactNode;
  // Wide controls (the three-option segmented switches) stack full-width under
  // the label on phones — the panel is only ~320px there, too tight to keep a
  // long-CJK segmented control inline. Compact toggles stay inline at the right
  // (cleaner, and they always fit), so they leave this off.
  block?: boolean;
}) {
  const isMobile = useIsMobile();
  const stacked = isMobile && block;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: stacked ? "column" : "row",
        alignItems: stacked ? "stretch" : "center",
        flexWrap: stacked ? "nowrap" : "wrap",
        gap: stacked ? 8 : "8px 12px",
        padding: "10px 0",
        borderBottom: `1px solid ${T.ruleSoft}`,
      }}
    >
      {/* Off the stacked path, keep a floor under the text column: a wide
          control sharing the row would otherwise squeeze it toward zero, and
          since CJK has no word breaks the label collapses into a
          one-character-per-line stack. */}
      <div style={{ flex: stacked ? "0 0 auto" : "1 1 150px" }}>
        <div style={{ font: `500 13.5px/1.3 ${T.sans}`, color: T.ink }}>
          {name}
        </div>
        {hint ? (
          <div
            style={{
              font: `12.5px/1.45 ${T.sans}`,
              color: T.dim,
              marginTop: 2,
            }}
          >
            {hint}
          </div>
        ) : null}
      </div>
      <div style={{ flex: "0 0 auto", width: stacked ? "100%" : undefined }}>
        {children}
      </div>
    </div>
  );
}
