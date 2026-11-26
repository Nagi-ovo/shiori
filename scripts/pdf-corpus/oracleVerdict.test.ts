import {expect,test} from 'bun:test';
import {OracleVerdictError,manifestPopplerVerdict,oracleVerdicts} from './oracleVerdict';

// Failure list for the manifest (reflow) Poppler check, dual verdict:
// - a reading-order permutation (two-column interleave, moved folio) fails the
//   legacy string equality but must pass the corrected signed scalar delta;
// - an inherited PDFium U+0002 / Poppler '-' disagreement must not fail the
//   corrected verdict, nor may it hide a real missing/extra/wrong scalar;
// - when both engines agree, the corrected verdict never fails (no false fail);
// - the hard gate stays legacy: auditCorpusSample throws OracleVerdictError
//   carrying both verdicts; ordinary errors thrown elsewhere carry neither.
const before='AB\u0002\r\nCD 12',popplerBefore='AB-\nCD\n12';
const after='AX\u0002\r\nCD 12',twoColumns='AX- 12\nCD';
test('a reading-order permutation fails legacy equality and passes the corrected delta',()=>{
 const verdict=manifestPopplerVerdict(popplerBefore,twoColumns,before,after);
 expect(verdict).toMatchObject({legacyPassed:false,correctedPassed:true,popplerComparison:'before-after-scalar-delta'});
 expect(verdict.legacyError).toContain('Poppler extracted text mismatch');
});
test('agreeing engines pass both verdicts and the gate does not throw',()=>{
 const verdict=manifestPopplerVerdict('ABCD','AXCD','ABCD','AXCD');
 expect(verdict).toMatchObject({legacyPassed:true,correctedPassed:true});
 for(const [pb,pa] of [['AB-CD','AX-CD'],['AB\nCD','CD\nAX']])
  expect(manifestPopplerVerdict(pb!,pa!,'AB\u0002CD','AX\u0002CD').correctedPassed).toBe(true);
});
test('missing, extra or wrong scalars fail both verdicts, also when hidden by a permutation',()=>{
 for(const bad of ['AX- 12','AX- 12\nCDD','AY- 12\nCD','AB- 12\nCD']){
  const verdict=manifestPopplerVerdict(popplerBefore,bad,before,after);
  expect(verdict).toMatchObject({legacyPassed:false,correctedPassed:false});
  expect(verdict.correctedError).toContain('Poppler extracted characters mismatch');
  expect(verdict.legacyError).toContain('Poppler extracted text mismatch');
 }
});
test('a corrected failure under a legacy pass keeps the legacy gate passing and records the disagreement',()=>{
 // Poppler drops a hyphen it had before; PDFium never had it: strings agree
 // after the edit but the deltas disagree.
 const verdict=manifestPopplerVerdict('AB-CD','AXCD','ABCD','AXCD');
 expect(verdict).toMatchObject({legacyPassed:true,correctedPassed:false,legacyError:undefined});
});
test('a legacy failure carries both verdicts; errors without a dual verdict report neither as passed',()=>{
 expect(oracleVerdicts(new OracleVerdictError('Poppler extracted text mismatch',false,true))).toEqual({legacyPassed:false,correctedPassed:true});
 expect(oracleVerdicts(new Error('untouched whitespace font program changed'))).toEqual({legacyPassed:false,correctedPassed:false});
});

// Failure list for a selected boundary space (gsa-17-195): the corrected
// verdict may treat a whitespace gap next to a replaced glyph as part of the
// edited span only if (1) it is inside originalText at that boundary and the
// replacement keeps it, (2) every source space lies in the edit boxes, and
// (3) the substitution re-emitted it: same count and text, the adjacent
// replacement glyph's font program, inside the edit boxes. Otherwise both
// verdicts fail; a strict pass never records a legacy failure.
const g=(text:string,x:number,fontHash='src',y=5)=>({text,origin:[x,y],box:[x,y-1,x+1,y+1],fontHash,
 nativePath:text.trim()?[{type:2,point:[1,1],closed:false}]:null,inkPixels:text.trim()?2:0});
const pixels=Buffer.alloc(1600,255);
const src={width:10,height:10,text:'A B \r\nC',glyphs:[g('A',1),g(' ',1.5),g('B',2),g(' ',3),g('C',1,'src',2)],pixels};
const box={x:0,y:3.5,w:5,h:3};
const sub=(trailing:readonly ReturnType<typeof g>[])=>({...src,text:'B A \r\nC',pixels:Buffer.from(pixels),
 glyphs:[g('B',1,'sub'),g(' ',1.4,'sub'),g('A',1.8,'sub'),...trailing,g('C',1,'src',2)]});
const span={originalText:'A B ',text:'B A ',coverRects:[box]};
test('a selected trailing space re-emitted by the substitution fails legacy and passes corrected',async()=>{
 const {compareNativePages}=await import('./oracle');
 const after=sub([g(' ',2.6,'sub')]);
 expect(()=>compareNativePages(src,after,span,true)).toThrow('untouched whitespace font program changed');
 const dual=compareNativePages(src,after,span,true,true);
 expect(dual.legacyWhitespaceError).toContain('untouched whitespace font program changed');
 expect(dual.maxOriginDriftPt).toBe(0);
});
test('boundary spaces outside originalText, unselected, dropped, duplicated or left in the source font still fail',async()=>{
 const {compareNativePages}=await import('./oracle');
 const cases:[typeof src,ReturnType<typeof sub>,typeof span][]=[
  [src,sub([g(' ',2.6,'sub')]),{...span,originalText:'A B'}],
  [src,sub([g(' ',2.6,'sub')]),{...span,text:'B A'}],
  [src,sub([g(' ',2.6,'sub')]),{...span,coverRects:[{...box,w:2.9}]}],
  [src,sub([]),span],
  [src,sub([g(' ',2.6,'sub'),g(' ',2.8,'sub')]),span],
  [src,sub([g(' ',2.6,'src')]),span],
  [src,sub([g(' ',2.6,'other')]),span],
  [src,sub([g(' ',6,'sub')]),span],
 ];
 for(const [before,after,edit] of cases)expect(()=>compareNativePages(before,after,edit,true,true)).toThrow(/whitespace|selects|count|text|outside/);
});
test('an untouched boundary space passes strictly and records no legacy failure',async()=>{
 const {compareNativePages}=await import('./oracle');
 const after=sub([g(' ',3)]);
 expect(compareNativePages(src,after,span,true,true).legacyWhitespaceError).toBeUndefined();
 expect(compareNativePages(src,after,span,true).legacyWhitespaceError).toBeUndefined();
});
test('a deletion that leaves an original glyph next to the gap cannot borrow its font as re-emission proof',async()=>{
 const {compareNativePages}=await import('./oracle');
 const after={...src,text:'A \r\nC',pixels:Buffer.from(pixels),glyphs:[g('A',1),g(' ',1.5),g('C',1,'src',2)]};
 expect(()=>compareNativePages(src,after,{...span,text:'A '},false,true)).toThrow('drift');
});
