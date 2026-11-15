import type { Overlay, PageModel } from '../../../pdf/model/types';
import type { LiveOverlayRevealBatch } from '../../../live/overlayReveal';
import { OverlaySvg } from './overlaySvg';
import { useContentTextPreview } from '../contentTextPreviewContext';
export function ContentTextCovers({overlays,page,scale,selectedIds,editingId,liveReveals}:{overlays:Overlay[];page:PageModel;scale:number;selectedIds:string[];editingId:string|null;liveReveals:readonly LiveOverlayRevealBatch[]}) {
 const {accepted,rasterized}=useContentTextPreview();
 return overlays.filter(o=>o.type==='contentText' && (!(rasterized??accepted).has(o.id) || editingId===o.id)).map(o=><OverlaySvg key={o.id} overlay={o} page={page} scale={scale} selected={selectedIds.includes(o.id)} liveReveals={liveReveals}/>);
}
