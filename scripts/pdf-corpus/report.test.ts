import {expect,test} from 'bun:test';
import {isHeadlineKind,markdownReport,summarize,summarizeReport,type CorpusRow} from './report';

// Failure list: retypeset must grow only the overlay-free numerator; unsupported
// stays in denominators; realistic overflow and legacy stress use distinct kind
// sets; empty groups remain finite; categories and JSON expose both rates;
// sampled oracle results never masquerade as a corpus-wide pass rate.
const row=(mode:CorpusRow['outcome']['mode'],category='chinese',kind='longer'):CorpusRow=>({
 id:`${category}-sample`,category,page:0,kind,original:'old',text:'new',ms:10,
 outcome:{overlayId:'edit',mode,...(mode==='unsupported'?{reason:'overflow' as const}:{})},
});
const exact=['in-place','fallback-font','substituted','reflowed'] as const;

test('summary partitions modes and distinguishes overlay-free success from exact-tier success',()=>{
 expect(summarize([...exact.map(mode=>row(mode)),row('retypeset'),row('unsupported'),row('unsupported')])).toEqual({
  edits:7,'in-place':1,'fallback-font':1,substituted:1,reflowed:1,retypeset:1,unsupported:2,
  succeededWithoutOverlay:5,succeededWithoutOverlayRate:5/7,exactTier:4,exactTierRate:4/7,
  acceptedRate:5/7,refusalRate:2/7,ms:70,reasons:{overflow:2},
 });
});

test('legacy and empty inputs retain finite rates and explicit mode counts',()=>{
 expect(summarize([])).toEqual({
  edits:0,'in-place':0,'fallback-font':0,substituted:0,reflowed:0,retypeset:0,unsupported:0,
  succeededWithoutOverlay:0,succeededWithoutOverlayRate:0,exactTier:0,exactTierRate:0,
  acceptedRate:0,refusalRate:0,ms:0,reasons:{},
 });
 expect(summarize([row('fallback-font')])).toMatchObject({acceptedRate:1,exactTierRate:1,substituted:0,reflowed:0});
 for(const summary of Object.values(summarizeReport([])))expect(summary).toEqual(summarize([]));
});

test('markdown exposes both rates and retypeset/unsupported counts by category and Chinese file',()=>{
 const rows=[row('substituted'),row('retypeset'),row('unsupported'),row('fallback-font','latex')];
 const md=markdownReport({rows,files:2,elapsedMs:100,skips:[],oracle:[{passed:true},{passed:false}],categories:['chinese','latex','word']});
 expect(md).toContain('| Succeeded without overlay | Exact-tier rate | Old-definition exact-tier rate |');
 expect(md).toContain('| 75.0% (3/4) | 50.0% (2/4) | 50.0% (2/4) |');
 expect(md).toContain('| Category | Edits | In place | Fallback font | Substituted | Reflowed | Retypeset | Unsupported | Succeeded without overlay | Exact-tier rate |');
 expect(md).toContain('| chinese | 3 | 0 | 0 | 1 | 0 | 1 | 1 | 66.7% | 33.3% |');
 expect(md).toContain('| latex | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 100.0% | 100.0% |');
 expect(md).toContain('| word | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | 0.0% |');
 expect(md).toContain('| overall | 4 | 0 | 1 | 1 | 0 | 1 | 1 | 75.0% | 50.0% |');
 expect(md).toContain('| chinese-sample | 3 | 0 | 0 | 1 | 0 | 1 | 1 | 66.7% | 33.3% |');
 expect(md).toContain('- overflow: 1');
 expect(md).toContain('Official saved-sample oracle: 1/2 passed');
 expect(md).toContain('No per-row corpus-wide raster oracle');
});

test('headline excludes only unbreakable overflow and keeps three comparable JSON rates',()=>{
 const rows=[row('in-place'),row('retypeset'),row('reflowed','chinese','overflow'),row('substituted','chinese','overflow-2'),
  row('retypeset','chinese','overflow-unbreakable'),row('unsupported','word','overflow-unbreakable'),row('unsupported','word')];
 for(const kind of ['overflow','overflow-2','missing-han','multi-line','future-kind'])expect(isHeadlineKind(kind)).toBe(true);
 expect(isHeadlineKind('overflow-unbreakable')).toBe(false);
 // Exactly the persisted run.ts summaries, including its all-row compatibility summary.
 const summaries=JSON.parse(JSON.stringify(summarizeReport(rows)));
 expect(summaries.summary).toEqual(summarize(rows));
 expect(summaries.summary.edits).toBe(rows.length);
 expect(summaries.headline).toMatchObject({edits:5,succeededWithoutOverlay:4,succeededWithoutOverlayRate:4/5,exactTier:3,exactTierRate:3/5,unsupported:1});
 expect(summaries.unbreakableOverflow).toMatchObject({edits:2,succeededWithoutOverlayRate:1/2,exactTierRate:0,retypeset:1,unsupported:1});
 expect(summaries.oldDefinition).toMatchObject({edits:5,succeededWithoutOverlayRate:3/5,exactTier:1,exactTierRate:1/5});
 const md=markdownReport({rows,files:2,elapsedMs:100,skips:[],oracle:[],categories:['chinese','word']});
 expect(md).toContain('| 80.0% (4/5) | 60.0% (3/5) | 20.0% (1/5) |');
 const [main,stressAndOld]=md.split('\n## Unbreakable overflow stress case');
 expect(main).toContain('| overall | 5 | 1 | 0 | 1 | 1 | 1 | 1 | 80.0% | 60.0% |');
 expect(main).toContain('Mean export time: 10.0 ms per edit.');
 const [stress,oldDefinition]=stressAndOld!.split('\n## Old-definition comparison');
 expect(stress).toContain('| overflow-unbreakable | 2 | 0 | 0 | 0 | 0 | 1 | 1 | 50.0% | 0.0% |');
 expect(oldDefinition).toContain('| old-definition | 5 | 1 | 0 | 0 | 0 | 2 | 2 | 60.0% | 20.0% |');
 expect(md).toContain('43.5%');expect(oldDefinition).toContain('48.6% (645/1328)');
});

test('oracle evidence is separate from outcome-based rates, including failures or no samples',()=>{
 const rows=[row('retypeset')],base={rows,files:1,elapsedMs:0,skips:[]};
 for(const oracle of [[],[{passed:false}],[{passed:true}]]){
  const md=markdownReport({...base,oracle});
  expect(md).toContain('| 100.0% (1/1) | 0.0% (0/1) | 0.0% (0/1) |');
  expect(summarizeReport(rows).headline.exactTierRate).toBe(0);
 }
});
