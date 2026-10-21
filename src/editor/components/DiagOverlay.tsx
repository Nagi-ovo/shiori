import { useState } from "react";
import type { DiagPayload } from "./pageCanvasDiagnostics";

export function DiagOverlay({
  diag,
  dialogLabel,
  closeLabel,
  onClose,
}: {
  diag: DiagPayload;
  dialogLabel: string;
  closeLabel: string;
  onClose: () => void;
}) {
  const text = JSON.stringify(diag, null, 2);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
      } catch {
        // clipboard blocked — user can still select manually
      }
    }
  };
  return (
    <div
      style={{
        position: "fixed",
        top: 80,
        right: 16,
        width: 460,
        maxHeight: "70vh",
        overflow: "auto",
        background: "#fff5f5",
        border: "2px solid #dc2626",
        borderRadius: 8,
        padding: 12,
        zIndex: 99999,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 11,
        color: "#1f2937",
        boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
      }}
      role="dialog"
      aria-label={dialogLabel}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <strong style={{ color: "#dc2626" }}>Shiori · render diagnostic</strong>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={copy}
            style={{
              padding: "2px 8px",
              border: "1px solid #dc2626",
              background: copied ? "#dc2626" : "#fff",
              color: copied ? "#fff" : "#dc2626",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            style={{
              padding: "2px 8px",
              border: "1px solid #9ca3af",
              background: "#fff",
              color: "#1f2937",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            ×
          </button>
        </div>
      </div>
      <pre
        style={{
          margin: 0,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text}
      </pre>
    </div>
  );
}
