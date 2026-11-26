import { useTranslation } from 'react-i18next';
import type { AcceptanceFindingKind } from '../../../pdf/export/acceptance';
import { contentTextWarningId, useContentTextPreview } from '../contentTextPreviewContext';
const faceLabel=(names:readonly string[])=>names.map(n=>n.replace(/\.(?:ttf|otf)$/i,'')).join(', ');
export function ContentTextWarning({id,editing,overflow,missing,inDraftStrip=false}:{id:string;editing:boolean;overflow:boolean;missing:number;inDraftStrip?:boolean}) {
 const {t}=useTranslation(),{outcomes,acceptance,pending,exclusionRefusal}=useContentTextPreview();
 const refusal=exclusionRefusal?.id===id?exclusionRefusal.reason:undefined;
 if(editing && refusal && !inDraftStrip)return null;
 const outcome=outcomes.find(o=>o.overlayId===id),manifest=outcome?.retypeset;
 // A resolved production outcome supersedes the page-character heuristic.
 const heuristicMissing=outcome && outcome.reason!=='font-unavailable'?0:missing;
 // Faces come only from what the writer recorded; a substitute without a
 // recorded name keeps the generic notice instead of a guessed one.
 const faces=outcome?.faces?.length?faceLabel(outcome.faces):null;
 const face=outcome?.mode==='substituted'?(faces?t('contentText.notices.substitutedFace',{face:faces}):t('contentText.notices.substituted'))
  :outcome?.mode==='fallback-font'?(faces?t('contentText.notices.fallbackFace',{face:faces}):t('contentText.notices.fallbackFont'))
  :manifest?(manifest.substituteFont?t('contentText.notices.retypesetFace',{face:faceLabel(manifest.substituteFont.split(', '))}):t('contentText.notices.sourceFontKept'))
  :outcome?.mode==='reflowed'?t('contentText.notices.reflowed'):null;
 const contact=outcome?.contact?.kind;
 const hasFinding=(kind:AcceptanceFindingKind,fallback?:boolean)=>acceptance
  ?acceptance.findings.some(finding=>finding.overlayId===id && finding.kind===kind):fallback;
 const preExisting=acceptance
  ?acceptance.notes.some(note=>note.overlayId===id && note.kind==='pre-existing-contact')
  :contact==='pre-existing-contact';
 const reasons=[editing && pending?t('contentText.notices.previewPending'):null,
  outcome?.standardFontMetrics?t('contentText.notices.standardFontMetrics')
   :outcome?.sourceSpacingAdjusted?t('contentText.notices.sourceSpacingAdjusted')
   :outcome?.mode==='retypeset'||outcome?.fidelity==='approximate'?t('contentText.notices.retypeset'):null,face,
  manifest?.overflowed?t('contentText.notices.frameOverflow'):null,
  hasFinding('new-collision',contact==='new-collision')?t('contentText.notices.newCollision'):null,
  preExisting?t('contentText.notices.preExistingContact'):null,
  hasFinding('uncertain-contact',contact==='uncertain')?t('contentText.notices.uncertainContact'):null,
  hasFinding('overflow-envelope',manifest?.overflowInkOverlap)?t('contentText.notices.retypesetOverflow'):null,
  hasFinding('stripped-equivalent',outcome?.strippedEquivalent)?t('contentText.notices.strippedEquivalent'):null,
  outcome?.reason && outcome.reason!==refusal?t(`contentText.reasons.${outcome.reason}`):null,
  editing && overflow && !outcome?t('overlays.contentTextOverflow'):null,
  editing && heuristicMissing>0?t('overlays.contentTextMissingGlyphs',{count:heuristicMissing}):null].filter(Boolean);
 if(!reasons.length)return null;
 const text=reasons.join(' · ');
 const placement=inDraftStrip?{whiteSpace:'normal' as const}:{position:'absolute' as const,top:'100%',left:0,marginTop:5,whiteSpace:'nowrap' as const};
 return <div id={contentTextWarningId(id)} role="status" title={text}
  style={{...placement,padding:'2px 8px',fontSize:11,lineHeight:'16px',background:'rgba(146, 96, 12, 0.95)',color:'#fff',borderRadius:4,pointerEvents:'none',zIndex:11}}>{text}</div>;
}
