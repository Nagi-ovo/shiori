import { useMemo, type ComponentProps } from 'react';
import { OverlayLayer } from './OverlayLayer';
import { useEditorStore } from '../store/store';
import { ContentTextPreviewSurface } from './ContentTextPreviewSurface';
export function ContentTextOverlayLayer(props:ComponentProps<typeof OverlayLayer>) {
 const opened=useEditorStore(s=>s.opened);
 const edits=useMemo(()=>props.overlays.filter(o=>o.type==='contentText'),[props.overlays]);
 if(!opened || !edits.length)return <OverlayLayer {...props}/>;
 return <ContentTextPreviewSurface bytes={opened.bytes} page={props.page} overlays={edits} scale={props.scale}>
  <OverlayLayer {...props}/>
 </ContentTextPreviewSurface>;
}
