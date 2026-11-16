import {expect} from 'bun:test';
import type {PDFPage} from 'pdf-lib';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import type {ContentTextOutcome,ContentTextReason} from './outcomes';
/** Inspect user-visible text and paint, not snapshots of a new implementation. */
export function expectRetypeset(page:PDFPage,outcome:ContentTextOutcome|undefined,before:ReturnType<typeof inspectRunPage>,replacement?:string,reason?:ContentTextReason){
 expect(outcome).toMatchObject({mode:'retypeset',fidelity:'approximate',retypeset:{pushed:false,...(reason?{reason}:{})}});
 const source=inspectRunPage(page);if(!source.ok)throw Error(source.reason);if(!before.ok)throw Error(before.reason);
 const ops=tokenizeContentStream(source.bytes),old=tokenizeContentStream(before.bytes);
 expect(ops.filter(o=>o.operator==='re').length).toBe(old.filter(o=>o.operator==='re').length);
 const glyphs=readRetypesetSource(page,ops).glyphs;
 if(replacement)expect(glyphs.map(g=>g.text??'').join('').replace(/\s/g,'')).toContain(replacement.normalize('NFC').replace(/\s/g,''));
 return glyphs;
}
