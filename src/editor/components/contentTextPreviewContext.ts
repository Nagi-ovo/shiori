import { createContext, useContext } from 'react';
import type { ContentTextOutcome } from '../../pdf/export/contentText/outcomes';
export type ContentTextPreviewState={accepted:ReadonlySet<string>;rasterized?:ReadonlySet<string>;outcomes:readonly ContentTextOutcome[]};
export const emptyContentTextPreview:ContentTextPreviewState={accepted:new Set(),outcomes:[]};
export const ContentTextPreviewContext=createContext(emptyContentTextPreview);
export const useContentTextPreview=()=>useContext(ContentTextPreviewContext);
