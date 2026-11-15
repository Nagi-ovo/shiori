import '../../test/setupDom';
import {cleanup,render} from '@testing-library/react';
import {afterEach,expect,test} from 'bun:test';
import i18n from '../../i18n';
import {ContentTextOutcomes} from './ContentTextOutcomes';
afterEach(cleanup);
test('labels exact editing modes and translates stable refusal reasons',async()=>{
 await i18n.changeLanguage('en');const view=render(<ContentTextOutcomes outcomes={[
 {overlayId:'a',mode:'in-place'},{overlayId:'b',mode:'fallback-font'},{overlayId:'c',mode:'overlay',reason:'overflow'}]}/>);
 expect(view.getByRole('status').textContent).toContain('In place');
 expect(view.getByRole('status').textContent).toContain('Embedded fallback font');
 expect(view.getByRole('status').textContent).toContain('exceeds the original');
});
