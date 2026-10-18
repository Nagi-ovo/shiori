import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import {
  getLiveZoomIndicator,
  subscribeLiveZoomIndicator,
} from "./liveZoomIndicator";
import { IconBtn } from "./ui";
import { MIN_ZOOM_SCALE } from "../zoomLimits";
import { typedZoom, zoomStepDown, zoomStepUp } from "../viewport/zoomCommands";

/**
 * Zoom readout that doubles as an editable field: shows `117%`, and on click
 * turns into a numeric input so the user can type an exact zoom (e.g. `150`).
 * Enter / blur commit (clamped to the ladder bounds); Escape reverts.
 */
function ZoomField({
  scale,
  setScale,
  label,
  minimumScale,
}: {
  scale: number;
  setScale: (s: number) => void;
  label: string;
  minimumScale: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = draft !== null;
  // During a pinch the committed scale intentionally stands still; the live
  // preview scale streams through this micro-store so only this readout
  // re-renders per gesture frame.
  const liveZoom = useSyncExternalStore(
    subscribeLiveZoomIndicator,
    getLiveZoomIndicator,
  );
  const shownScale = liveZoom ?? scale;

  const commit = (raw: string) => {
    const typed = typedZoom(raw, minimumScale);
    if (typed !== null) setScale(typed);
    setDraft(null);
  };

  // Commit + close on any pointer-down outside the input. onBlur alone isn't
  // enough: clicking the document area can call preventDefault on pointerdown,
  // which suppresses the input's blur and would otherwise leave the field
  // stuck open.
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      const el = inputRef.current;
      if (el && !el.contains(e.target as Node)) commit(el.value);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        inputMode="numeric"
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
          }
        }}
        style={{
          width: 48,
          height: 28,
          textAlign: "center",
          font: `500 12.5px/1 ${T.mono}`,
          fontVariantNumeric: "tabular-nums",
          color: T.ink,
          background: T.surface,
          border: `1px solid ${T.accent}`,
          borderRadius: 6,
          outline: "none",
          padding: 0,
        }}
      />
    );
  }

  return (
    <button
      type="button"
      title={label}
      onClick={() => setDraft(String(Math.round(scale * 100)))}
      style={{
        minWidth: 48,
        height: 28,
        textAlign: "center",
        font: `500 12.5px/1 ${T.mono}`,
        fontVariantNumeric: "tabular-nums",
        color: T.ink2,
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: 6,
        cursor: "text",
        padding: 0,
      }}
    >
      {Math.round(shownScale * 100)}%
    </button>
  );
}

/**
 * The `[-] 100% [+]` zoom cluster. Generic over its scale source: the PDF
 * toolbar drives the store `scale`; the Markdown / HTML viewer drives a
 * per-document text zoom.
 */
export function ZoomControls({
  scale,
  setScale,
  zoomOutLabel,
  zoomInLabel,
  zoomLevelLabel,
  minimumScale = MIN_ZOOM_SCALE,
}: {
  scale: number;
  setScale: (s: number) => void;
  zoomOutLabel: string;
  zoomInLabel: string;
  zoomLevelLabel: string;
  minimumScale?: number;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        flex: "0 0 auto",
      }}
    >
      <IconBtn
        title={zoomOutLabel}
        disabled={scale <= minimumScale + 1e-6}
        onClick={() => setScale(zoomStepDown(scale, minimumScale))}
      >
        <Ic.zoomOut />
      </IconBtn>
      <ZoomField
        scale={scale}
        setScale={setScale}
        label={zoomLevelLabel}
        minimumScale={minimumScale}
      />
      <IconBtn
        title={zoomInLabel}
        onClick={() => setScale(zoomStepUp(scale, minimumScale))}
      >
        <Ic.zoomIn />
      </IconBtn>
    </div>
  );
}
