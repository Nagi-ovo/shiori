import {expect,test} from 'bun:test';
import {summarizeReport,type CorpusRow} from './report';

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
  unchangedLineDrift:{availability:'partial',eligibleRows:5,measuredRows:4,unavailableRows:1,count:3,rate:3/5,measuredRate:3/4,maxPt:2,p95Pt:2,thresholdPt:0},
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
