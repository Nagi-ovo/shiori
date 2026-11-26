import {expect,test} from 'bun:test';
import {summarizeReport,type CorpusRow} from './report';
import {qualityMarkdown} from './qualityReport';

// Failure list: absent and partial telemetry is unavailable, never a measured
// zero; push-adjusted x/baseline residuals use max then nearest-rank p95;
// overlap accepts boolean or area, only on overflowed retypeset rows; missing
// overflow state and invalid values remain explicit. Headline kinds stay put.
function row(quality?:Record<string,unknown>,overflowed=true,kind='longer'):CorpusRow{
 return {id:'quality',category:'latex',page:0,kind,original:'old',text:'new',ms:0,
  outcome:{overlayId:'edit',mode:'retypeset',retypeset:{paragraphBox:{x:0,y:0,w:20,h:20},lineCount:2,
   substituteFont:null,overflowed,pushed:false,reason:'overflow',...(quality?{quality}:{})}}};
}
const drift=(x:number,y:number)=>({maxUnchangedLineStartXDriftPt:x,maxUnchangedLineBaselineDriftPt:y});
test('legacy manifests expose unavailable quality and retain outcome headlines',()=>{
 const rows=[row(),{...row(),outcome:{overlayId:'edit',mode:'retypeset' as const}}];
 const report=JSON.parse(JSON.stringify(summarizeReport(rows)));
 expect(report.headline).toMatchObject({succeededWithoutOverlayRate:1,exactTierRate:0,retypeset:2});
 expect(report.quality).toMatchObject({scope:'headline',retypesetRows:2,
  unchangedLineDrift:{availability:'unavailable',eligibleRows:2,measuredRows:0,unavailableRows:2,count:0,rate:0,maxPt:0,p95Pt:0},
  overflowInkOverlap:{availability:'unavailable',eligibleRows:1,measuredRows:0,unavailableRows:1,unknownOverflowRows:1,count:0,rate:0}});
 expect(report.quality.note).toContain('unavailable');
});
test('quality counts residual drift and overflow overlap without changing denominators',()=>{
 const rows=[row({...drift(0,0),overflowInkOverlap:false}),row({...drift(.25,.1),overflowInkOverlap:true}),
  row({...drift(0,2),overflowInkOverlapAreaPt2:3}),row({...drift(1,0),overflowInkOverlap:true},false),row(),
  row({...drift(100,100),overflowInkOverlap:true},true,'overflow-unbreakable')];
 const report=summarizeReport(rows);
 expect(report.headline).toMatchObject({edits:5,succeededWithoutOverlayRate:1,exactTierRate:0});
 expect(report.quality).toMatchObject({scope:'headline',retypesetRows:5,
  unchangedLineDrift:{availability:'partial',eligibleRows:5,measuredRows:4,unavailableRows:1,count:3,rate:3/5,measuredRate:3/4,maxPt:2,p95Pt:2,thresholdPt:.01},
  overflowInkOverlap:{availability:'partial',eligibleRows:4,measuredRows:3,unavailableRows:1,count:2,rate:2/4,measuredRate:2/3,areaMeasuredRows:1,totalAreaPt2:3,maxAreaPt2:3}});
});
test('p95 uses per-row max residuals; zeros are measured and invalid data stays unavailable',()=>{
 const rows=Array.from({length:20},(_,i)=>row(drift(i,i/2)));
 expect(summarizeReport(rows).quality.unchangedLineDrift).toMatchObject({availability:'available',count:19,rate:19/20,maxPt:19,p95Pt:18});
 const invalid=[{maxUnchangedLineStartXDriftPt:1},drift(-1,0),drift(NaN,0),drift(0,Infinity),{overflowInkOverlapAreaPt2:-1}];
 expect(summarizeReport(invalid.map(q=>row(q))).quality.unchangedLineDrift).toMatchObject({availability:'unavailable',measuredRows:0});
 expect(summarizeReport([row(drift(0,0))]).quality.unchangedLineDrift).toMatchObject({availability:'available',count:0,rate:0,maxPt:0,p95Pt:0});
 expect(summarizeReport([row({overflowInkOverlapAreaPt2:0})]).quality.overflowInkOverlap).toMatchObject({availability:'available',count:0,areaMeasuredRows:1});
 expect(summarizeReport([]).quality).toMatchObject({retypesetRows:0,unchangedLineDrift:{rate:0,maxPt:0,p95Pt:0},overflowInkOverlap:{rate:0}});
});

// r31 failure list: drift at or below 0.01 pt (float noise under the 1e-4 pt
// writer verifier) is no defect but stays visible as positiveRows; a fit that
// stops overflowing must stay in the fixed pressure cohort; flagged rows that
// never overflowed must count in the all-flagged rate; accepted-and-overlap-free
// subtracts flagged and unmeasured rows; duplicate (id, page, text) inputs
// count once in the distinct view; vertical rows never enter NV overlap rates.
type Extra={category?:string;id?:string;page?:number;text?:string;fitStrategy?:'fit-envelope'|'tighten-frame'|'chain-push';mode?:CorpusRow['outcome']['mode']};
function nvRow(flag:boolean|undefined,overflowed:boolean,extra:Extra={},kind='longer'):CorpusRow{
 const base=row(flag===undefined?drift(0,0):{...drift(0,0),overflowInkOverlap:flag},overflowed,kind);
 const mode=extra.mode??'retypeset';
 return {...base,id:extra.id??base.id,category:extra.category??base.category,page:extra.page??0,text:extra.text??base.text,
  outcome:mode==='retypeset'?{...base.outcome,retypeset:{...base.outcome.retypeset!,...(extra.fitStrategy?{fitStrategy:extra.fitStrategy}:{})}}:
   {overlayId:'edit',mode,...(mode==='unsupported'?{reason:'overflow' as const}:{})}};
}
test('M1: drift threshold is 0.01 pt; noise below it stays visible but is not a defect',()=>{
 const rows=[row(drift(1e-13,0)),row(drift(0,.01)),row(drift(.0101,0)),row(drift(0,0))];
 expect(summarizeReport(rows).quality.unchangedLineDrift).toMatchObject({thresholdPt:.01,boundPt:1e-4,
  count:1,positiveRows:3,eligibleRows:4,measuredRows:4,maxPt:.0101});
 expect(qualityMarkdown(summarizeReport(rows).quality).join('\n')).toContain('writer-invariant residual');
});
test('M2/M3: fixed cohort keeps fitted rows; all-flagged counts non-overflowed rows; overlap-free subtracts flagged and unmeasured',()=>{
 const rows=[nvRow(true,true),nvRow(false,true),nvRow(false,false,{fitStrategy:'fit-envelope'}),nvRow(false,false,{fitStrategy:'tighten-frame'}),
  nvRow(false,false,{fitStrategy:'chain-push'}),nvRow(true,false),nvRow(undefined,false),nvRow(undefined,false,{mode:'in-place'}),nvRow(undefined,false,{mode:'unsupported'})];
 const nv=summarizeReport(rows).quality.nonVertical;
 expect(nv).toMatchObject({headlineRows:9,acceptedRows:8,retypesetRows:7,
  overflowedOverlap:{eligibleRows:2,count:1,rate:1/2},
  fixedCohortOverlap:{eligibleRows:4,count:1,rate:1/4},
  perHeadlineOverlap:{count:1,rows:9,rate:1/9},
  allFlaggedOverlap:{eligibleRows:7,measuredRows:6,count:2,nonOverflowedFlaggedRows:1,ratePerHeadline:2/9},
  acceptedOverlapFree:{count:5,acceptedRows:8,flaggedRows:2,unmeasuredRows:1}});
});
test('M2: every row flagged gives a 100% cohort rate, never a rate above one',()=>{
 const rows=[nvRow(true,true),nvRow(true,true),nvRow(true,false)];
 expect(summarizeReport(rows).quality.nonVertical).toMatchObject({overflowedOverlap:{count:2,rate:1},fixedCohortOverlap:{count:2,rate:1},
  allFlaggedOverlap:{count:3,rate:1},acceptedOverlapFree:{count:0}});
});
test('M4: duplicate (id, page, text) inputs count once; distinct edits keep different pages, files and texts',()=>{
 const same={id:'f',page:1,text:'t as noted'};
 const rows=[nvRow(true,true,same,'overflow'),nvRow(true,true,same,'overflow-2'),
  nvRow(false,true,{...same,page:2},'overflow'),nvRow(true,true,{...same,page:2,text:'t as noted here'},'overflow-2'),
  nvRow(undefined,false,{id:'g',mode:'in-place'}),nvRow(undefined,false,{id:'g',mode:'unsupported',text:'other'})];
 expect(summarizeReport(rows).quality.nonVertical.distinct).toMatchObject({rows:6,edits:5,duplicateRows:1,
  succeeded:4,exactTier:1,overflowedRows:3,overflowedFlagged:2,allFlagged:2,duplicateFlaggedRows:1});
});
test('M6: vertical overlap is not pooled into non-vertical rates and is reported as not measured',()=>{
 const rows=[nvRow(true,true),nvRow(false,true),nvRow(true,true,{category:'vertical'}),nvRow(false,true,{category:'vertical'})];
 const q=summarizeReport(rows).quality;
 expect(q.overflowInkOverlap).toMatchObject({legacy:true,eligibleRows:4,count:2});
 expect(q.nonVertical).toMatchObject({headlineRows:2,overflowedOverlap:{eligibleRows:2,count:1},allFlaggedOverlap:{count:1}});
 expect(q.vertical).toMatchObject({measured:false,headlineRows:2,retypesetRows:2,producerFlaggedRows:1});
 const md=qualityMarkdown(q).join('\n');
 expect(md).toContain('not measured; refuse-on-collision');
 expect(md).toMatch(/Legacy pooled overflow overlap \(all headline rows, vertical included\)/);
 expect(md).toContain('| Non-vertical: overlap / overflowed rows (legacy definition) | 1/2 | 50.0% |');
});
