import { useCallback, useMemo } from "react";
import {
  LeftNavigator,
  type LeftNavigatorProps,
} from "../../editor/components/LeftNavigator";
import {
  documentTreeAnchors,
  type DocumentTreeAnchor,
} from "../../editor/components/documentTreeAnchors";
import {
  useEditorStore,
  useEditorStoreApi,
} from "../../editor/store/store";

type Props = Omit<
  LeftNavigatorProps,
  "anchors" | "onOpenAnchor" | "selectedIds"
>;

/** Owns annotation/selection subscriptions needed only by the navigator. */
export function PdfDocumentNavigator(props: Props) {
  const editorStore = useEditorStoreApi();
  const pages = useEditorStore((state) => state.model.pages);
  const overlays = useEditorStore((state) => state.model.overlays);
  const selectedIds = useEditorStore((state) => state.selectedIds);
  const goToPage = useEditorStore((state) => state.goToPage);
  const anchors = useMemo(
    () => documentTreeAnchors(overlays, pages),
    [overlays, pages],
  );
  const onOpenAnchor = useCallback(
    (anchor: DocumentTreeAnchor) => {
      const overlay = overlays.find((item) => item.id === anchor.id);
      if (!overlay) return;
      const index = pages.findIndex((page) => page.id === overlay.pageId);
      if (index < 0) return;
      goToPage(overlay.pageId, index);
      editorStore.setState({ selectedIds: [overlay.id] });
    },
    [editorStore, goToPage, overlays, pages],
  );

  return (
    <LeftNavigator
      {...props}
      anchors={anchors}
      onOpenAnchor={onOpenAnchor}
      selectedIds={selectedIds}
    />
  );
}
