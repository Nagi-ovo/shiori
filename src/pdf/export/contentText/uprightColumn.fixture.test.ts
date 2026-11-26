import {PDFDocument,type PDFPage} from 'pdf-lib';
import {readFile} from 'node:fs/promises';
import type {PdfRect} from '../../model/types';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import {bounds} from './retypesetInk';
import {columnInk} from './uprightColumnInk';
import {columnsOf,uprightScale,type ColumnCell} from './uprightColumnPlan';
import {overlay} from './fixtures.test-support';

export const loadFont=(name:string)=>readFile(`src/assets/fonts/${name}`).then(b=>new Uint8Array(b));
export async function verticalCorpusPage(id:string,index=0){
 const source=await PDFDocument.load(await readFile(`scripts/pdf-corpus/fixtures/vertical/${id}.pdf`));
 const doc=await PDFDocument.create(),[copied]=await doc.copyPages(source,[index]);doc.addPage(copied!);
 return{doc,page:doc.getPage(0)};
}
/** Source columns read the way a user sees them: right to left, top down. */
export function pageColumns(page:PDFPage){
 const content=inspectRunPage(page);if(!content.ok)throw Error(content.reason);
 const ops=tokenizeContentStream(content.bytes),source=readRetypesetSource(page,ops);
 const cells=source.glyphs.flatMap(g=>{const font=source.fonts.find(f=>f.resourceName===g.glyph.fontName),s=uprightScale(g.state);if(!font||!s)return[];const width=font.widthOf(g.glyph.code)*g.state.fontSize/1000*s.x;return[{glyph:g,font,cx:g.x+width/2,em:g.state.fontSize*s.y,width} satisfies ColumnCell];});
 const ink=columnInk(page,source.fonts,ops);
 return{source,columns:columnsOf(cells),box:(c:ColumnCell)=>ink(c.font,c.glyph.glyph.code,c.glyph.state,c.glyph.x,c.glyph.y).box};
}
/** A UI-shaped edit over selected cells: one advance/ink cover per cell, 0.8 pt guard. */
export function columnEdit(cells:readonly ColumnCell[],box:(c:ColumnCell)=>PdfRect,text:(original:string)=>string){
 const covers=cells.map(c=>{const b=bounds([...c.glyph.glyph.coreQuad,{x:box(c).x,y:box(c).y},{x:box(c).x+box(c).w,y:box(c).y+box(c).h}]);return{x:b.x-.8,y:b.y-.8,w:b.w+1.6,h:b.h+1.6};});
 const originalText=cells.map(c=>c.glyph.text??'').join(''),rect=bounds(covers.flatMap(r=>[{x:r.x,y:r.y},{x:r.x+r.w,y:r.y+r.h}]));
 return overlay({originalText,text:text(originalText),rect,coverRects:covers,fontSize:Math.round(cells[0]!.em)});
}
