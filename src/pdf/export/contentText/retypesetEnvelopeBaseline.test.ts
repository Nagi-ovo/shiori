import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {PDFName} from 'pdf-lib';
import {fixture,overlay} from './fixtures.test-support';
import {applyRetypesets} from './retypeset';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import type {ContentTextOutcome} from './outcomes';

// Rows the pipeline already handles (pushes, frame tightens) and failure rows
// outside the envelope ladder's reach must keep byte-identical output. The
// digests were taken from the pipeline before the ladder existed. r31: a
// one-letter growth of a one-line title now fits its own ink band (P2-A),
// so the single-line cases grow by three letters (below the .85 floor);
// their digests were re-taken with the envelope ladder disabled.
const title='BT /F1 20 Tf 24 TL 50 150 Td (ABCDEFGHIJ) Tj ET ',body='BT /F1 10 Tf 50 105 Td (FOLLOWING) Tj ET ';
const longer=(text='ABCDEFGHIJK')=>overlay({text,originalText:'ABCDEFGHIJ',fontSize:20,coverRects:[{x:49,y:147,w:122,h:24}]});
const column='BT /F1 10 Tf 12 TL 50 150 Td (AAAA BBBB CCCC DDDD) Tj T* (EEEE FFFF GGGG HHHH) Tj ET 0.4 w 10 127 m 290 127 l S '+body;
const columnEdit=(suffix:string)=>overlay({text:'EEEE FFFF GGGG HHHH'+suffix,originalText:'EEEE FFFF GGGG HHHH',fontSize:10,coverRects:[{x:49,y:136,w:116,h:11}]});
const cases:{name:string;stream:string;text?:string;edit?:ReturnType<typeof overlay>;image?:boolean;annot?:boolean}[]=[
 {name:'push-rule',stream:title+'0.4 w 47 127 m 173 127 l S '+body+'BT /F1 10 Tf 220 105 Td (OTHER) Tj ET'},
 {name:'push-image',stream:title+'q 126 0 0 18 47 114 cm /Image Do Q '+body+'BT /F1 10 Tf 220 105 Td (OTHER) Tj ET',image:true},
 {name:'push-indented-text',stream:title+'BT /F1 10 Tf 47 126 Td (WIDER COLUMN LINE HERE) Tj ET '+body+'BT /F1 10 Tf 220 105 Td (OTHER) Tj ET'},
 {name:'push-footer-gap',stream:title+'0.4 w 47 127 m 173 127 l S '+body+'BT /F1 10 Tf 50 40 Td (FOOTER) Tj ET'},
 {name:'push-annotation',stream:title+'0.4 w 47 127 m 173 127 l S '+body,annot:true},
 {name:'tighten-cell',stream:'0.4 w 45 140 m 175 140 l S 45 174 m 175 174 l S 45 140 m 45 174 l S 175 140 m 175 174 l S '+title+body},
 {name:'tighten-box',stream:'0.4 w 45 140 130 34 re S '+title+body},
 {name:'tighten-banner',stream:'0.8 g 40 140 240 34 re f 0 g '+title+body,text:'ABCDEFGHIJKLMNOPQRS'},
 {name:'tighten-spacing',stream:'0.4 w 45 140 138 34 re S '+title+body},
 {name:'frame-exhausted',stream:'0.4 w 45 140 130 34 re S '+title+body,text:'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ'},
 {name:'single-line-barrier',stream:title+'0.4 w 10 127 m 290 127 l S '+body,text:'ABCDEFGHIJKLM'},
 {name:'single-line-foreign',stream:title+'0.4 w 47 127 m 180 127 l S '+body+'BT /F1 10 Tf 176 105 Td (FOREIGN) Tj ET',text:'ABCDEFGHIJKLM'},
 // Column rows too long for the ladder even at the .85 floor.
 {name:'column-exhausted',stream:column,edit:columnEdit(' IIII JJJJ')},
 {name:'column-unbreakable-word',stream:column,edit:columnEdit(' IIIIII')},
];
async function run(c:typeof cases[number]){
 const f=await fixture(c.stream);
 if(c.image){const ref=f.doc.context.register(f.doc.context.stream(Uint8Array.of(0),{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8}));f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Image:ref}));}
 if(c.annot)f.page.node.set(PDFName.of('Annots'),f.doc.context.obj([{Type:'Annot',Subtype:'Link',Rect:[220,120,260,145]}]));
 const e=c.edit??longer(c.text),outcomes=new Map<string,ContentTextOutcome>();await applyRetypesets(f.page,[e],outcomes,new Set(),{});
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const m=outcomes.get(e.id)?.retypeset;
 return {digest:createHash('sha256').update(s.bytes).digest('hex').slice(0,16),pushed:m?.pushed,overlap:m?.overflowInkOverlap,strategy:m?.fitStrategy};
}
const expected:Record<string,string>={
 'push-rule':'ec15c2dc6b6a711f',
 'push-image':'743a06bffe6339ef',
 'push-indented-text':'33d9223d35e6eca6',
 'push-footer-gap':'f663440f7ef88e3a',
 'push-annotation':'cf76fb561539ce49',
 'tighten-cell':'41ea065ebaa5ed50',
 'tighten-box':'7218650db67598c8',
 'tighten-banner':'6003c4aa6ac86a7a',
 'tighten-spacing':'f99cfca776d676e8',
 'frame-exhausted':'b04c2efa3f2576bc',
 'single-line-barrier':'a8fe3cc599538ea0',
 'single-line-foreign':'660de0d9e860a56b',
 'column-exhausted':'8f82606e570b8fd3',
 'column-unbreakable-word':'4e3bad2fd52936af',
};
for(const c of cases)test(`existing outcome is byte-identical: ${c.name}`,async()=>{
 const r=await run(c);
 if(process.env.PRINT_ENVELOPE_BASELINE)console.log(JSON.stringify([c.name,r]));
 expect(r.digest).toBe(expected[c.name]!);
});
