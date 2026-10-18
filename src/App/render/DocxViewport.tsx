import { DocxViewer } from "../../editor/components/DocxViewer";
import {
  setTabTextScrollTop,
  setTabTextZoom,
} from "../../workspace/appWorkspace";
import type { WorkspaceRuntimeTab } from "../../workspace/types";
import { DocumentLoadingState } from "./DocumentLoadingState";

/** A Word tab's viewport: the document once loaded, its loading state before. */
export function DocxViewport({
  tab,
  fitToWidth,
  onRetry,
}: {
  tab: WorkspaceRuntimeTab;
  fitToWidth: boolean;
  onRetry: () => void;
}) {
  if (tab.status !== "loaded" || !tab.bytes) {
    return <DocumentLoadingState tab={tab} onRetry={onRetry} />;
  }
  return (
    <DocxViewer
      key={tab.id}
      bytes={tab.bytes}
      documentId={tab.id}
      initialScrollTop={tab.textView?.scrollTop ?? 0}
      zoom={tab.textView?.zoom ?? 1}
      fitToWidth={fitToWidth}
      onZoomChange={(zoom) => setTabTextZoom(tab.id, zoom)}
      onScrollTopChange={(scrollTop) => setTabTextScrollTop(tab.id, scrollTop)}
    />
  );
}
