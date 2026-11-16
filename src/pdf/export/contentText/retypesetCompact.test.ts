import {expect,test} from 'bun:test';
import {compactMap,compactOffset} from './retypesetCompact';
import {compactGlyphs} from './retypesetCompact';
import {fixture} from './fixtures.test-support';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {address,paragraphGroups,readRetypesetSource} from './retypesetSource';

test('compact scalar offsets round-trip through original UTF-16 and glyph homes',()=>{
 const text=' 😀 f\u00adfi-\r\nZ',map=compactMap(text,true);
 expect(map.map(c=>c.char).join('')).toBe('😀ffiZ');
 for(const [i,c]of map.entries()){
  expect(compactOffset(map,c.start)).toBe(i);
  expect(compactOffset(map,c.end)).toBe(i+1);
  expect(text.slice(c.start,c.end)).toBe(c.char);
 }
 expect(map[0]).toMatchObject({start:1,end:3});
 expect(compactMap('AB\u0002\nCD').map(c=>c.char).join('')).toBe('AB-CD');
 expect(compactMap('AB\u0002\nCD',true).map(c=>c.char).join('')).toBe('ABCD');
 expect(compactMap('AB-CD',true).map(c=>c.char).join('')).toBe('AB-CD');
});

test('folded compact positions round-trip to scalar offsets inside the same source glyph',async()=>{
 const f=await fixture('BT /F1 10 Tf 50 150 Td (AB-) Tj 0 -14 Td (CD) Tj ET');
 const ops=tokenizeContentStream(f.source),read=readRetypesetSource(f.page,ops);
 read.glyphs[0]!.text='😀ffi';read.glyphs[1]!.text='\u00ad';
 const group=paragraphGroups(read.glyphs,ops,read.glyphs[0]!,read.glyphs).group!;
 const atoms=group.lines.flatMap(l=>l.glyphs.map(g=>({text:g.text!,home:g,bytes:Uint8Array.of(g.glyph.code)})));
 const map=compactGlyphs(atoms,group,true),original=atoms.map(a=>a.text).join('');
 expect(map.map(c=>c.char).join('')).toBe('😀ffiCD');
 for(const [i,c]of map.entries()){
  expect(compactOffset(map,c.start)).toBe(i);
  expect(original.slice(c.start,c.end)).toBe(c.char);
  expect(atoms[c.atom]!.text.slice(c.offset,c.offset+c.end-c.start)).toBe(c.char);
  expect(address(atoms[c.atom]!.home.glyph)).toBe(address(read.glyphs[c.atom]!.glyph));
 }
 expect(map.slice(0,4).map(c=>[c.atom,c.offset])).toEqual([[0,0],[0,2],[0,3],[0,4]]);
});
