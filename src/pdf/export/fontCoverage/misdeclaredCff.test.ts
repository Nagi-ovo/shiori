import {expect,test} from 'bun:test';
import {createFontCoverage} from './coverage';
import {tinyCff,tinyTtf,sfnt} from './fixtures/programs';
import {cidCff} from './fixtures/cidCff';
import type {FontInput} from './types';

// Failure inventory: STATUS.md. Both native CID access and sfnt GID access
// must select the same outline; nonidentity CFF mappings remain unproved.
const map=new Uint8Array(6);map[3]=1;map[5]=2;
const input=(extra:Partial<FontInput>={}):FontInput=>({subtype:'Type0',cidSubtype:'CIDFontType2',programKind:'FontFile2',
 encoding:'Identity-H',program:cidCff(),cidToGid:map,toUnicode:'1 beginbfchar <0001> <0041> endbfchar',...extra});
const head=new Uint8Array(54);new DataView(head.buffer).setUint16(18,1000);
for(const program of [cidCff(),sfnt({'CFF ':cidCff(),head,maxp:Uint8Array.of(0,0,0x50,0,0,3)},true)]){
 test(`CIDFontType2 detects actual CID CFF bytes (${program.length}) and verifies the agreed GID`,()=>{
  const f=createFontCoverage(input({program}));
  expect(f.verification).toBe('verified');expect(f.glyphIds.get('0001')).toBe(1);
  expect(f.canEncode('AA')).toMatchObject({ok:true,bytes:Uint8Array.of(0,1,0,1)});
  const declared=createFontCoverage(input({program,cidSubtype:'CIDFontType0',programKind:'FontFile3'}));
  expect(f.glyphIds).toEqual(declared.glyphIds);expect(f.encodable).toEqual(declared.encodable);
 });
}
for(const cidToGid of [new Uint8Array(6),Uint8Array.of(0)] as const)test(`ambiguous CFF mapping stays unproved (${cidToGid.length})`,()=>{
 const f=createFontCoverage(input({cidToGid}));
 expect(f.canEncode('A').ok).toBe(false);expect(f.glyphIds.get('0001')??0).toBe(0);
});
test.each([undefined,'Identity'] as const)('identity CFF charset supports the default/explicit Identity map (%s)',cidToGid=>{
 expect(createFontCoverage(input({cidToGid})).canEncode('A')).toMatchObject({ok:true,bytes:Uint8Array.of(0,1)});
});
test('nonidentity CFF charset is ambiguous even when CIDToGIDMap agrees with its inverse',()=>{
 const map=new Uint8Array(86);map[85]=1;
 const f=createFontCoverage(input({program:cidCff({charset:[42,7]}),cidToGid:map,toUnicode:'1 beginbfchar <002a> <0041> endbfchar'}));
 expect(f.canEncode('A').ok).toBe(false);expect(f.glyphIds.get('002a')??0).toBe(0);
});
test('name-keyed CFF cannot supply a CIDFontType2 proof',()=>{
 const f=createFontCoverage(input({program:tinyCff(false)}));
 expect(f.canEncode('A').ok).toBe(false);expect(f.glyphIds.size).toBe(0);
});
test('an absent CFF charstring cannot supply an ink resolver GID',()=>{
 const f=createFontCoverage(input({program:cidCff({missingGlyph:true})}));
 expect(f.canEncode('A').ok).toBe(false);expect(f.glyphIds.has('0001')).toBe(false);
});
for(const program of [new Uint8Array(),Uint8Array.of(0,1,0,0),tinyCff().slice(0,20)])test(`corrupt/non-CFF bytes have no coverage (${program.length})`,()=>{
 const f=createFontCoverage(input({program}));
 expect(f.verification).toBe('unverified');expect(f.canEncode('A').ok).toBe(false);expect(f.glyphIds.size).toBe(0);
});
test('real glyf in CIDFontType2 keeps its PDF map even when no CFF charset agrees',()=>{
 const map=new Uint8Array(86);map[85]=7;
 const f=createFontCoverage(input({program:tinyTtf(),cidToGid:map,toUnicode:'1 beginbfchar <002a> <0041> endbfchar'}));
 expect(f.verification).toBe('verified');expect(f.glyphIds.get('002a')).toBe(7);
 expect(f.canEncode('A')).toMatchObject({ok:true,bytes:Uint8Array.of(0,42)});
 const identity=createFontCoverage(input({program:tinyTtf(),cidToGid:undefined,toUnicode:'1 beginbfchar <0001> <0041> endbfchar'}));
 expect(identity.canEncode('A')).toMatchObject({ok:true,bytes:Uint8Array.of(0,1)});
 expect(identity.glyphIds.get('0001')).toBe(1);
});
