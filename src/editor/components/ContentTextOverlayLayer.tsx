import { useMemo, type ComponentProps } from "react";
import { pdfPaperColor } from "../../design/pdfPaperTone";
import { useAppStore, useEditorStore } from "../store/store";
import { OverlayLayer } from "./OverlayLayer";
import { ContentTextPreviewSurface } from "./ContentTextPreviewSurface";
import { SourceImageLayer } from "./SourceImageLayer";

export function ContentTextOverlayLayer(props: ComponentProps<typeof OverlayLayer>) {
  const opened = useEditorStore(s => s.opened);
  const editingId = useEditorStore(s => s.editingOverlayId);
  const flowChains = useEditorStore(s => s.model.flowChains);
  const paperColor = useAppStore(s => pdfPaperColor(s.prefs.pdfPaperTone, s.prefs.pdfPaperCustomColor));
  const edits = useMemo(() => props.overlays.filter(o => o.type === "contentText" || o.type === "sourceImageEdit"), [props.overlays]);
  const annotations = useMemo(() => props.overlays.filter(o => o.type !== "sourceImageEdit"), [props.overlays]);
  if (!opened) return <OverlayLayer {...props} overlays={annotations} />;
  return <ContentTextPreviewSurface bytes={opened.bytes} sourceDoc={opened.doc} page={props.page}
    overlays={edits} scale={props.scale} editingId={editingId} paperColor={paperColor} flowChains={flowChains}>
    <SourceImageLayer {...props} opened={opened} annotations={annotations} />
  </ContentTextPreviewSurface>;
}
