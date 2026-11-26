import {useCallback,useMemo} from 'react';
import type {PdfDocument,PdfEngine} from '../../pdf/engine/types';
import type {ContentTextOverlay,PageModel} from '../../pdf/model/types';
import {useEditorStore} from '../store/store';
import {readEditedPageText} from './editedPageText';
export function useContentTextPageReader(doc:PdfDocument,page:PageModel,sourceEditing:boolean){
 const bytes=useEditorStore(s=>s.opened?.bytes),overlays=useEditorStore(s=>s.model.overlays);
 const edits=useMemo(()=>sourceEditing?[]:overlays.filter((o):o is ContentTextOverlay=>o.type==='contentText' && o.pageId===page.id),[sourceEditing,overlays,page.id]);
 return useCallback((options:Parameters<PdfEngine['pageText']>[2])=>readEditedPageText(doc,page,bytes,edits,options),[doc,page,bytes,edits]);
}
