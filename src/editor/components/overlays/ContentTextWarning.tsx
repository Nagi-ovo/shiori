import { useTranslation } from 'react-i18next';
import { useContentTextPreview } from '../contentTextPreviewContext';
export function ContentTextWarning({id,editing,overflow,missing}:{id:string;editing:boolean;overflow:boolean;missing:number}) {
 const {t}=useTranslation(),{outcomes}=useContentTextPreview();
 const outcome=outcomes.find(o=>o.overlayId===id);
 // A resolved production outcome supersedes the page-character heuristic.
 const heuristicMissing=outcome && outcome.reason!=='font-unavailable'?0:missing;
 const reasons=[outcome?.mode==='substituted'||outcome?.mode==='reflowed'?t(`contentText.notices.${outcome.mode}`):null,
  outcome?.reason?t(`contentText.reasons.${outcome.reason}`):null,
  editing && overflow?t('overlays.contentTextOverflow'):null,
  editing && heuristicMissing>0?t('overlays.contentTextMissingGlyphs',{count:heuristicMissing}):null].filter(Boolean);
 if(!reasons.length)return null;
 return <div title={reasons.join(' · ')} style={{position:'absolute',top:'100%',left:0,marginTop:5,padding:'2px 8px',fontSize:11,lineHeight:'16px',background:'rgba(146, 96, 12, 0.95)',color:'#fff',borderRadius:4,whiteSpace:'nowrap',pointerEvents:'none',zIndex:11}}>{reasons.join(' · ')}</div>;
}
