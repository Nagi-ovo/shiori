import { createContext, useContext } from 'react';
import type { ContentTextOverlay, SourceImageEditOverlay } from '../../pdf/model/types';
import type { AcceptanceVerdict } from '../../pdf/export/acceptance';
import type { ContentTextOutcome, ContentTextReason } from '../../pdf/export/contentText/outcomes';
/** accepted: the writer drew these edits. excluded: the displayed frame is the
 * page with these edits' source glyphs removed and nothing written in their
 * place (keyed by contentTextExclusionKey), so the DOM must paint their text. */
export type ContentTextPreviewState={
 imageEdits?:readonly SourceImageEditOverlay[];
 imageFailed?:boolean;
 /** A newer frame containing image edits is still being built. */
 imagePending?:boolean;
 accepted:ReadonlySet<string>;
 excluded?:ReadonlyMap<string,string>;
 // The displayed frame's exclusion result, independent of the typed text's
 // export outcome. Only a settled refusal for the current edit reveals the draft.
 exclusionRefusal?:{id:string;key:string;reason:ContentTextReason};
 outcomes:readonly ContentTextOutcome[];
 /** The settled verdict for the actual edits, including any live draft. */
 acceptance?:AcceptanceVerdict;
 /** The active draft is waiting for its writer outcome. */
 pending?:boolean;
};
export const emptyContentTextPreview:ContentTextPreviewState={accepted:new Set(),outcomes:[]};
export const ContentTextPreviewContext=createContext(emptyContentTextPreview);
export const contentTextWarningId=(id:string)=>`content-text-warning-${id}`;
export const useContentTextPreview=()=>useContext(ContentTextPreviewContext);
/** The replacement that removes an edit's source glyphs while keeping its
 * line structure: every source line becomes empty. */
export function contentTextExclusion(o:ContentTextOverlay):ContentTextOverlay {
 // localActivityAt is stamped on every store patch (each keystroke) and paints nothing.
 return {...o,localActivityAt:undefined,text:o.originalText.split('\n').map(()=>'').join('\n')};
}
/** Identity of an exclusion frame: everything but the typed text. */
export const contentTextExclusionKey=(o:ContentTextOverlay)=>JSON.stringify(contentTextExclusion(o));
/** Whether the DOM should paint this edit's glyphs. Otherwise the displayed
 * page already shows them: the source text (no frame yet, or refused) or the
 * writer's rendering of the edit. Never both, so no cover is needed. */
export function contentTextGlyphsShown(state:ContentTextPreviewState,o:ContentTextOverlay):boolean {
 const key=state.excluded?.get(o.id);
 return key!==undefined && key===contentTextExclusionKey(o);
}
