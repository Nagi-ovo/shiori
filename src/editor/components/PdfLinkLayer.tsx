import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CSSProperties, MouseEvent } from "react";
import type { PageModel } from "../../pdf/model/types";
import { appPdfEngine } from "../../pdf/engine/appEngine";
import type { PdfDestination, PdfDocument, PdfLink } from "../../pdf/engine/types";
import { pdfToDisplay, rotatedSize } from "../../pdf/geometry/coords";
import { CAPABILITIES, isWebPanelUrl, openExternalUrl } from "../../platform";
import { T } from "../../design/tokens";
import { toast } from "../toast";
import { useAppStore, useEditorStore } from "../store/store";

type Props = {
  doc: PdfDocument;
  page: PageModel;
  scale: number;
  layerScale: number;
  onNavigate: (target: PdfLinkTarget) => void;
};

export type PdfLinkTarget = {
  pageIndex: number;
  /** Null for a named action that only picks a page (FirstPage, NextPage, …). */
  destination: PdfDestination | null;
};

type LinkLayerStyle = CSSProperties & {
  "--shiori-link-focus": string;
  "--shiori-link-hover": string;
};

/**
 * The page's links as real anchors, so they take focus, show their URL and
 * open where a link should: web pages in the embedded browser panel on
 * desktop (or the system browser), destinations by scrolling. The links come
 * from the engine (`pageLinks`), once per page face; a zoom only rescales the
 * layer. Only URLs and destinations are followed: a document's JavaScript
 * actions never reach this layer through either engine, and forms are drawn
 * into the page raster, never made interactive here.
 */
function PdfLinkLayerImpl({ doc, page, scale, layerScale, onNavigate }: Props) {
  const { t } = useTranslation();
  const active = useEditorStore((s) => s.tool === "select");
  // Keyed by the page they were read for, so a recycled layer never shows
  // another page's links while its own load.
  const pageKey = page.sourceIndex;
  const [loaded, setLoaded] = useState<{ doc: PdfDocument; pageKey: number; links: PdfLink[] } | null>(null);
  const links = loaded && loaded.doc === doc && loaded.pageKey === pageKey ? loaded.links : [];
  const size = rotatedSize(page.widthPt, page.heightPt, page.rotation);
  const transformScale = layerScale !== scale ? scale / layerScale : 1;
  const style: LinkLayerStyle = {
    position: "absolute",
    inset: 0,
    width: size.width * layerScale,
    height: size.height * layerScale,
    transform: transformScale !== 1 ? `scale(${transformScale})` : undefined,
    transformOrigin: "top left",
    "--shiori-link-focus": T.accent,
    "--shiori-link-hover": T.accentSoft,
  };

  useEffect(() => {
    let cancelled = false;
    appPdfEngine
      .pageLinks(doc, pageKey)
      .then((next) => {
        if (!cancelled) setLoaded({ doc, pageKey, links: next });
      })
      .catch((err: unknown) => {
        console.error("link layer failed to read links", err);
      });
    return () => {
      cancelled = true;
    };
  }, [doc, pageKey]);

  const openUrl = async (url: string) => {
    // Desktop routes web links to the embedded Browser panel (the panel
    // serves the request with its own bounds); everything else, and the web
    // build, falls back to the system browser.
    if (CAPABILITIES.embeddedBrowserPanel && isWebPanelUrl(url)) {
      useAppStore.getState().openBrowserPanel(url);
      return;
    }
    try {
      await openExternalUrl(url);
    } catch {
      toast.error(t("toast.linkOpenFailed"));
    }
  };

  const follow = (link: PdfLink) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (link.url) {
      void openUrl(link.url);
    } else if (link.destination) {
      onNavigate({ pageIndex: link.destination.pageIndex, destination: link.destination });
    } else if (link.action) {
      const last = appPdfEngine.pageCount(doc) - 1;
      const pageIndex = {
        FirstPage: 0,
        LastPage: last,
        NextPage: Math.min(last, page.sourceIndex + 1),
        PrevPage: Math.max(0, page.sourceIndex - 1),
      }[link.action];
      onNavigate({ pageIndex, destination: null });
    }
  };

  const ox = page.originXPt ?? 0;
  const oy = page.originYPt ?? 0;
  return (
    <div
      className={`annotationLayer shioriPdfLinkLayer${active ? " is-active" : ""}`}
      style={style}
    >
      {links.map((link, index) => {
        const [left, bottom, right, top] = link.rect;
        const a = pdfToDisplay(
          { x: left - ox, y: bottom - oy },
          page.widthPt,
          page.heightPt,
          page.rotation,
          layerScale,
        );
        const b = pdfToDisplay(
          { x: right - ox, y: top - oy },
          page.widthPt,
          page.heightPt,
          page.rotation,
          layerScale,
        );
        return (
          <section
            key={index}
            className="linkAnnotation"
            style={{
              left: Math.min(a.x, b.x),
              top: Math.min(a.y, b.y),
              width: Math.abs(b.x - a.x),
              height: Math.abs(b.y - a.y),
            }}
          >
            <a
              data-shiori-pdf-link="true"
              draggable={false}
              href={link.url ?? destinationHash(link)}
              title={link.url ?? undefined}
              target={link.url ? "_blank" : undefined}
              rel={link.url ? "noopener noreferrer" : undefined}
              onClick={follow(link)}
            />
          </section>
        );
      })}
    </div>
  );
}

function destinationHash(link: PdfLink): string {
  if (link.destination) {
    return `#${encodeURIComponent(JSON.stringify(link.destination))}`;
  }
  return link.action ? `#${link.action}` : "#";
}

// Memoized: links depend only on doc/page/scale (onNavigate is a stable
// useCallback), so this layer skips the per-frame parent re-renders driven by
// scrolling and overlay drags.
export const PdfLinkLayer = memo(PdfLinkLayerImpl);
