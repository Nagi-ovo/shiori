import { T } from "../../design/tokens";
import type { DocumentPreviewData } from "./documentPreview";

/** Decorative visual shared by hidden tabs and the document navigator. */
export function DocumentPreviewSurface({
  preview,
  height,
  htmlScale,
}: {
  preview: DocumentPreviewData;
  height: number;
  htmlScale: number;
}) {
  return (
    <div
      aria-hidden="true"
      style={{
        height,
        borderRadius: 6,
        overflow: "hidden",
        background: T.paper,
        boxShadow: "0 0 0 1px rgba(0,0,0,0.10)",
        position: "relative",
        flex: "none",
      }}
    >
      {preview.imageUrl ? (
        <img
          src={preview.imageUrl}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            display: "block",
            objectFit: "contain",
            background: T.paper,
          }}
        />
      ) : preview.htmlPreview ? (
        <iframe
          title=""
          tabIndex={-1}
          scrolling="no"
          sandbox=""
          srcDoc={`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline' data:; font-src data:;"><base target="_blank">${preview.htmlPreview}`}
          style={{
            width: 800,
            height: 600,
            border: 0,
            transform: `scale(${htmlScale})`,
            transformOrigin: "top left",
            background: "#fff",
          }}
        />
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            padding: "16px 18px",
            overflow: "hidden",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            font: `10.5px/1.65 ${T.mono}`,
            color: T.ink2,
            background: T.cream,
          }}
        >
          {preview.textPreview}
        </div>
      )}
    </div>
  );
}
