import { expect, test } from 'bun:test';
import { createFontCoverage } from './coverage';
import { tinyCff, tinyTtf, sfnt } from './fixtures/programs';

test('MacExpert Standard14 covers its small-cap encoding',()=>{
  const f=createFontCoverage({subtype:'Type1',baseFont:'Helvetica',encoding:'MacExpertEncoding'});
  // MacExpert code 32 is space. Helvetica lacks small-cap names, so no
  // assumption may turn the rest of this table into invented glyphs.
  expect(f.canEncode(' ').ok).toBe(true);
  expect(f.canEncode('A').ok).toBe(false);
});
test('symbolic TrueType without ToUnicode cannot borrow StandardEncoding names',()=>{
  const f=createFontCoverage({subtype:'TrueType',flags:4,program:tinyTtf({maps:[{platform:3,encoding:0,entries:[[0xf041,7]]}]})});
  expect(f.canEncode('A').ok).toBe(false);
});
test('odd CIDToGIDMap fails explicitly',()=>{
  const f=createFontCoverage({subtype:'Type0',cidSubtype:'CIDFontType2',encoding:'Identity-H',program:tinyTtf(),cidToGid:Uint8Array.of(0,1,0),toUnicode:'1 beginbfchar <0001> <0053> endbfchar'});
  expect(f.canEncode('S')).toMatchObject({ok:false,reason:expect.stringContaining('truncated CIDToGIDMap')});
});
test('OpenType CFF resolves a CID charset through the same oracle',()=>{
  const head=new Uint8Array(54);new DataView(head.buffer).setUint16(18,1000);
  const f=createFontCoverage({subtype:'Type0',cidSubtype:'CIDFontType0',encoding:'Identity-H',program:sfnt({'CFF ':tinyCff(),head,maxp:Uint8Array.of(0,0,0x50,0,0,3)},true),toUnicode:'1 beginbfchar <002a> <0041> endbfchar'});
  expect(f.canEncode('A')).toMatchObject({ok:true});
});
test('truncated CFF charstring cannot claim coverage',()=>{
  const f=createFontCoverage({subtype:'Type0',cidSubtype:'CIDFontType0',encoding:'Identity-H',program:tinyCff().slice(0,-2),toUnicode:'1 beginbfchar <0007> <0042> endbfchar'});
  expect(f.canEncode('B').ok).toBe(false);
});
