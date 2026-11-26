import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ContentTextReason } from "../../../pdf/export/contentText/outcomes";
import "./contentTextDraftStrip.css";

export function ContentTextDraftStrip({
  reason,
  descriptionId,
  children,
}: {
  reason: ContentTextReason | undefined;
  descriptionId: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const stripRef = useRef<HTMLDivElement>(null);
  const open = reason !== undefined;

  useLayoutEffect(() => {
    if (!open) return;
    const strip = stripRef.current;
    const canvas = strip?.closest<HTMLElement>(".shioriCanvas");
    if (!strip || !canvas) return;

    // Lift the focused field out of the page's clipping and transforms
    // without reparenting it. Focus, selection, native undo and IME stay put.
    if (strip.showPopover) {
      strip.setAttribute("popover", "manual");
      strip.showPopover();
    }
    const place = () => {
      const { left, top, width } = canvas.getBoundingClientRect();
      strip.style.left = `${left}px`;
      strip.style.top = `${top}px`;
      strip.style.width = `${width}px`;
      canvas.style.setProperty("--shiori-content-text-draft-inset", `${strip.offsetHeight}px`);
    };
    place();
    const observer = new window.ResizeObserver(place);
    observer.observe(canvas);
    observer.observe(strip);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      strip.removeAttribute("popover");
      strip.removeAttribute("style");
      canvas.style.removeProperty("--shiori-content-text-draft-inset");
    };
  }, [open]);

  return (
    <div ref={stripRef} className={open ? "shioriContentTextDraft is-refused" : "shioriContentTextDraft"}>
      {reason && <div id={descriptionId} role="status">
        {t("contentText.draftOffPage")} {t(`contentText.reasons.${reason}`)}
      </div>}
      {children}
    </div>
  );
}
