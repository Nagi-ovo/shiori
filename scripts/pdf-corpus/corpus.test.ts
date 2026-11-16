import {expect,test} from 'bun:test';
import {verifyPdf,samplePages} from './fetch';
import {editMatrix} from './editMatrix';
import {createHash} from 'node:crypto';
const data=new TextEncoder().encode('%PDF-1.7\nexample');
const entry={bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};
test('download verification rejects stale hashes, truncated files and non-PDF responses',()=>{
 expect(()=>verifyPdf(data,entry)).not.toThrow();
 expect(()=>verifyPdf(data,{...entry,bytes:1})).toThrow('size');
 expect(()=>verifyPdf(data,{...entry,sha256:'0'.repeat(64)})).toThrow('hash');
 expect(()=>verifyPdf(new TextEncoder().encode('<html>'),{...entry,bytes:6})).toThrow('PDF');
});
test('page sampling is deterministic, bounded and covers document endpoints',()=>{
 expect(samplePages(100)).toEqual([0,24,49,74,99]);expect(samplePages(3)).toEqual([0,1,2]);
 expect(samplePages(0)).toEqual([]);
});
test('fixed edit matrix exercises different failure paths without identity substitutions',()=>{
 const edits=editMatrix('Hello world');expect(edits.map(e=>e.kind)).toEqual(['same-length','missing-glyph','shorter','longer','overflow','overflow-2','overflow-unbreakable','substring']);
 for(const e of edits)expect(e.text).not.toBe('Hello world');
 expect(editMatrix('日本語の文章').some(e=>e.kind==='cjk')).toBe(true);
});
test('PDFium geometry passes through the production paragraph detector and overlay geometry helpers',async()=>{
 const {buildCorpusOverlays}=await import('./overlays');
 const page={id:'p',sourceIndex:0,rotation:0 as const,widthPt:300,heightPt:200};
 const glyphs=Array.from('Hello world',(text,i)=>({text,origin:[50+i*6,100] as [number,number],box:[50+i*6,98,56+i*6,108] as [number,number,number,number],fontSize:10,angle:0,object:'one',nativeIndex:i}));
 const edits=buildCorpusOverlays({glyphs,width:300,height:200,text:'Hello world',pages:1},page);
 expect(edits[0]).toMatchObject({originalText:'Hello world',fontSize:10,sourceBaselinesPt:[100]});
 expect(edits[0]!.coverRects[0]!.x).toBeLessThan(50);
});
test('Chinese fallback targets a Han cluster provably absent from the addressed source font',async()=>{
 const {fixture,overlay}=await import('../../src/pdf/export/contentText/fixtures.test-support');
 const {resolveRunFonts}=await import('../../src/pdf/export/contentStreamEdit/replaceRunPage');
 const {missingHanEdit}=await import('./missingHan');
 const f=await fixture(),fonts=resolveRunFonts(f.page);fonts[0]!.unicodeByCode=new Map(fonts[0]!.unicodeByCode).set(65,'中');
 const edit=missingHanEdit(f.source,fonts,overlay({originalText:'中BCDE',text:'中BCDE'}));
 expect(edit).toMatchObject({kind:'missing-han',text:'测BCDE',missingHan:'测'});
 expect(fonts[0]!.canEncode!('测').ok).toBe(false);
 expect(missingHanEdit(f.source,fonts,overlay())).toBeNull();
});
test('the corpus normalizes oversized font bboxes using the same UI vertical-metric policy',async()=>{
 const{buildCorpusOverlays}=await import('./overlays');const glyphs=Array.from('中文段落',(text,i)=>({text,origin:[50+i*10,100] as [number,number],box:[50+i*10,88,60+i*10,122] as [number,number,number,number],fontSize:10,angle:0,object:'one',nativeIndex:i}));
 expect(buildCorpusOverlays({width:300,height:200,pages:1,text:'中文段落',glyphs},{id:'p',sourceIndex:0,widthPt:300,heightPt:200,rotation:0})[0]).toMatchObject({originalText:'中文段落',fontSize:10});
});
