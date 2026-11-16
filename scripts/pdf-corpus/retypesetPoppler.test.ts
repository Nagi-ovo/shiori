import {expect,test} from 'bun:test';
import {assertRetypesetPopplerText} from './retypesetPoppler';

// Failure list: unchanged source engine disagreement and new spatial order
// may pass; missing/extra/wrong output, or changed baseline disagreement may not.
test('wrapped retypeset compares engine deltas despite inherited control-character hyphens',()=>{
 const nativeBefore='Preprint\r\nrepresen\u0002tations mul\u0002tiple';
 const nativeAfter='Preprint\r\ni\r\nrepresen\u0002tations mul\u0002tiple';
 const popplerBefore='Preprint\nrepresen-\ntations mul-\ntiple';
 const popplerAfter='represen-\ntations mul-\ntiple\nPreprint\ni';
 expect(()=>assertRetypesetPopplerText(popplerBefore,popplerAfter,nativeBefore,nativeAfter)).not.toThrow();
 for(const bad of [popplerBefore,popplerAfter+'i',popplerAfter.slice(0,-1)+'j',popplerAfter.replace('-','')])
  expect(()=>assertRetypesetPopplerText(popplerBefore,bad,nativeBefore,nativeAfter)).toThrow('Poppler extracted characters mismatch');
});
test('matching extraction still rejects native-only or Poppler-only missing and extra scalars',()=>{
 for(const [popplerAfter,nativeAfter] of [['AXC','AXC'],['AC','AXC'],['AXXC','AXC'],['AXC','AC'],['AXC','AXXC']]){
  const compare=()=>assertRetypesetPopplerText('ABC',popplerAfter!,'ABC',nativeAfter!);
  if(popplerAfter===nativeAfter)expect(compare).not.toThrow();else expect(compare).toThrow('Poppler extracted characters mismatch');
 }
});
