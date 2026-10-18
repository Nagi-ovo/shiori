import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { IconBtn } from "./ui";
import { ShioriTile } from "../../brand/Mark";

type Props = {
  fileName: string;
  onImport: () => void;
  onAddPage: () => void;
};

export function EmptyScreen({ fileName, onImport, onAddPage }: Props) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: T.paper,
        display: "flex",
        flexDirection: "column",
        fontFamily: T.sans,
        color: T.ink,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "14px 20px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderBottom: `1px solid ${T.rule}`,
          background: T.cream,
          flex: "0 0 auto",
        }}
      >
        <ShioriTile size={20} radius={0.22} />
        <span
          style={{
            fontFamily: T.klee,
            fontWeight: 600,
            fontSize: 16,
            lineHeight: 1,
            color: T.ink,
          }}
        >
          {t("app.brand")}
        </span>
        <div style={{ flex: 1 }} />
        <span
          style={{
            font: `500 10.5px/1 ${T.mono}`,
            color: T.dim,
            letterSpacing: ".08em",
            textTransform: "uppercase",
          }}
        >
          {fileName}
        </span>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          overflow: "auto",
        }}
      >
        <div style={{ maxWidth: 460, textAlign: "center" }}>
          <div
            style={{
              font: `${T.displayStyle} 32px/1.15 ${T.serif}`,
              color: T.ink,
              letterSpacing: "-.01em",
              marginBottom: 10,
            }}
          >
            {t("empty.title")}
          </div>
          <div
            style={{
              font: `14.5px/1.55 ${T.sans}`,
              color: T.ink2,
            }}
          >
            {t("empty.message")}
          </div>
          <div
            style={{
              display: "flex",
              gap: 10,
              justifyContent: "center",
              marginTop: 24,
              flexWrap: "wrap",
            }}
          >
            <IconBtn tone="outline" onClick={onImport}>
              {t("empty.import")}
            </IconBtn>
            <IconBtn tone="primary" onClick={onAddPage}>
              {t("empty.addPage")}
            </IconBtn>
          </div>
        </div>
      </div>
    </div>
  );
}
