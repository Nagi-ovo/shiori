import '../../../test/setupDom';
import {cleanup,render} from '@testing-library/react';
import {afterEach,expect,test} from 'bun:test';
import i18n from '../../../i18n';
import {ContentTextPreviewContext,type ContentTextPreviewState} from '../contentTextPreviewContext';
import {ContentTextWarning} from './ContentTextWarning';
import {evaluateAcceptance} from '../../../pdf/export/acceptance';
afterEach(cleanup);
for(const [mode,notice]of [['substituted','This text was rewritten in a substitute font.'],['reflowed','This text was reflowed to fit the edited paragraph.'],['retypeset','Layout may change.']]as const)test(`successful ${mode} has a visible notice`,async()=>{
 await i18n.changeLanguage('en');
 const view=render(<ContentTextPreviewContext.Provider value={{accepted:new Set(['edit']),outcomes:[{overlayId:'edit',mode}]}}><ContentTextWarning id="edit" editing={false} overflow={false} missing={0}/></ContentTextPreviewContext.Provider>);
 expect(view.getByText(notice)).toBeTruthy();
});

const manifest=(patch:object)=>({paragraphBox:{x:0,y:0,w:10,h:10},substituteFont:null,lineCount:2,overflowed:false,overflowInkOverlap:false,pushed:false,reason:'overflow',...patch}) as never;
const draw=(value:ContentTextPreviewState,props:{editing?:boolean;overflow?:boolean}={})=>render(<ContentTextPreviewContext value={value}><ContentTextWarning id="edit" editing={props.editing??false} overflow={props.overflow??false} missing={0}/></ContentTextPreviewContext>);
test('frame overflow and ink overlap are reported independently after editing',async()=>{
 await i18n.changeLanguage('en');
 const outcome=(patch:object)=>({accepted:new Set(['edit']),outcomes:[{overlayId:'edit',mode:'retypeset' as const,fidelity:'approximate' as const,retypeset:manifest({substituteFont:'Noto.otf',...patch})}]});
 expect(draw(outcome({overflowed:true})).getByRole('status').textContent).toBe('Layout may change. · Set in the substitute font Noto. · Text extends past its original frame.');
 cleanup();
 expect(draw(outcome({overflowInkOverlap:true})).getByRole('status').textContent).toBe('Layout may change. · Set in the substitute font Noto. · Text may overlap nearby content.');
});
test.each(['clear','pre-existing-contact','new-collision'] as const)('discloses the overflow envelope and removed equivalent with %s contact',async kind=>{
 await i18n.changeLanguage('en');
 const outcomes=[{overlayId:'edit',mode:'retypeset' as const,retypeset:manifest({overflowInkOverlap:true}),
  strippedEquivalent:true,contact:{kind,region:{x:1,y:2,w:3,h:4}}}];
 const acceptance=evaluateAcceptance({lostChars:0,contentTextOutcomes:outcomes},'review');
 const notice=draw({accepted:new Set(['edit']),outcomes,acceptance}).getByRole('status').textContent;
 expect(notice).toContain('Text may overlap nearby content.');
 expect(notice).toContain('This edit removes alternate text associated with the original.');
 if(kind==='pre-existing-contact')expect(notice).toContain('Nearby content already touched the original text.');
 if(kind==='new-collision')expect(notice).toContain('The edit overlaps nearby content in the highlighted area.');
});
test('a fallback without a recorded face keeps an honest generic notice',async()=>{
 await i18n.changeLanguage('en');
 expect(draw({accepted:new Set(['edit']),outcomes:[{overlayId:'edit',mode:'fallback-font'}]}).getByRole('status').textContent).toBe('Missing characters use a bundled font.');
});
test('an in-place edit that kept its font shows nothing',()=>{
 expect(draw({accepted:new Set(['edit']),outcomes:[{overlayId:'edit',mode:'in-place',fidelity:'exact'}]}).queryByRole('status')).toBeNull();
});
test('the width heuristic yields to a resolved result and does not repeat a reported overflow',async()=>{
 await i18n.changeLanguage('en');
 const fitted={accepted:new Set(['edit']),outcomes:[{overlayId:'edit',mode:'in-place' as const}]};
 expect(draw(fitted,{editing:true,overflow:true}).queryByRole('status')).toBeNull();cleanup();
 // A newer draft is pending, so its own width estimate is all that is available.
 expect(draw({accepted:fitted.accepted,outcomes:[],pending:true},{editing:true,overflow:true}).getByRole('status').textContent).toBe('Updating preview… · Wider than the original text — export may wrap or overflow');cleanup();
 const overflowed={accepted:new Set(['edit']),outcomes:[{overlayId:'edit',mode:'retypeset' as const,retypeset:manifest({overflowed:true})}]};
 expect(draw(overflowed,{editing:true,overflow:true}).getByRole('status').textContent).toBe('Layout may change. · Original font kept. · Text extends past its original frame.');
});
for(const [lang,face,frame]of [['zh','已改用替代字体 LiberationSans-Bold 重写。','文字超出原有文本框。'],['ja','代替フォント LiberationSans-Bold で書き直しました。','テキストが元の枠からはみ出しています。']]as const)test(`${lang} names the face and the frame`,async()=>{
 await i18n.changeLanguage(lang);
 expect(draw({accepted:new Set(['edit']),outcomes:[{overlayId:'edit',mode:'substituted',faces:['LiberationSans-Bold.ttf']}]}).getByRole('status').textContent).toBe(face);
 cleanup();
 expect(draw({accepted:new Set(['edit']),outcomes:[{overlayId:'edit',mode:'retypeset',retypeset:manifest({overflowed:true})}]}).getByRole('status').textContent).toContain(frame);
 await i18n.changeLanguage('en');
});
