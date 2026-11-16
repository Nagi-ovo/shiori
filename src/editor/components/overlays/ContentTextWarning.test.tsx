import '../../../test/setupDom';
import {cleanup,render} from '@testing-library/react';
import {afterEach,expect,test} from 'bun:test';
import i18n from '../../../i18n';
import {ContentTextPreviewContext} from '../contentTextPreviewContext';
import {ContentTextWarning} from './ContentTextWarning';
afterEach(cleanup);
for(const [mode,notice]of [['substituted','This text was rewritten in a substitute font.'],['reflowed','This text was reflowed to fit the edited paragraph.'],['retypeset','Layout may change.']]as const)test(`successful ${mode} has a visible notice`,async()=>{
 await i18n.changeLanguage('en');
 const view=render(<ContentTextPreviewContext.Provider value={{accepted:new Set(['edit']),outcomes:[{overlayId:'edit',mode}]}}><ContentTextWarning id="edit" editing={false} overflow={false} missing={0}/></ContentTextPreviewContext.Provider>);
 expect(view.getByText(notice)).toBeTruthy();
});

test('approximate fidelity and overflow remain visible after editing',async()=>{
 await i18n.changeLanguage('en');
 const view=render(<ContentTextPreviewContext value={{accepted:new Set(['edit']),outcomes:[{overlayId:'edit',mode:'retypeset',fidelity:'approximate',retypeset:{paragraphBox:{x:0,y:0,w:10,h:10},substituteFont:'Noto',lineCount:2,overflowed:true,pushed:false,reason:'overflow'}}]}}><ContentTextWarning id="edit" editing={false} overflow={false} missing={0}/></ContentTextPreviewContext>);
 expect(view.getByText('Layout may change. · Text may overlap nearby content.')).toBeTruthy();
});
