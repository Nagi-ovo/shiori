import { Canvas } from "../../editor/components/Canvas";
import { EmptyScreen } from "../../editor/components/EmptyScreen";
import { Thumbnails } from "../../editor/components/Thumbnails";
import type { PdfDocument } from "../../pdf/engine/types";

/**
 * An open PDF's viewport: the page canvas, the phone's thumbnail drawer and
 * the scrim that closes it, or the empty screen once every page is deleted.
 */
export function PdfViewport({
  doc,
  fileName,
  empty,
  isMobile,
  showThumbs,
  showRail,
  onDismissDrawers,
  pdfInsertionBusy,
  onInsertPdfPages,
  onImport,
  onAddPage,
}: {
  doc: PdfDocument;
  fileName: string;
  empty: boolean;
  isMobile: boolean;
  showThumbs: boolean;
  showRail: boolean;
  /** Closes the thumbnail drawer and the rail, the scrim's tap on a phone. */
  onDismissDrawers: () => void;
  pdfInsertionBusy: boolean;
  onInsertPdfPages: (afterPageId: string | null) => void;
  onImport: () => void;
  onAddPage: () => void;
}) {
  if (empty) {
    return (
      <EmptyScreen fileName={fileName} onImport={onImport} onAddPage={onAddPage} />
    );
  }
  return (
    <>
      {showThumbs && isMobile ? (
        <Thumbnails
          doc={doc}
          pdfInsertionBusy={pdfInsertionBusy}
          onInsertPdfPages={onInsertPdfPages}
        />
      ) : null}
      <Canvas doc={doc} />
      {isMobile && (showThumbs || showRail) ? (
        <div
          onClick={onDismissDrawers}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(20,16,10,0.32)",
            zIndex: 44,
            WebkitTapHighlightColor: "transparent",
          }}
          aria-hidden
        />
      ) : null}
    </>
  );
}
