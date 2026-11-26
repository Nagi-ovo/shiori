import {describe,expect,test} from 'bun:test';
import {createFontCoverage} from './coverage';
import {tinyCff,tinyTtf} from './fixtures/programs';
import type {FontInput} from './types';

const labels='1 beginbfchar <0001> <4e00> endbfchar';
const cid=(extra:Partial<FontInput>={})=>createFontCoverage({subtype:'Type0',cidSubtype:'CIDFontType2',
  encoding:'Identity-H',program:tinyTtf(),toUnicode:labels,...extra});

describe('missing source Unicode labels',()=>{
  for(const cff of [false,true])test(`CID ${cff?'CFF':'TrueType'} refuses unlabelled Latin and Han`,()=>{
    const f=cff?cid({cidSubtype:'CIDFontType0',program:tinyCff(),
      toUnicode:'1 beginbfchar <002a> <4e00> endbfchar'}):cid();
    expect(f.verification).toBe('verified');
    for(const missing of ['i','试'])expect(f.canEncode('一'+missing)).toEqual({
      ok:false,reason:'no ToUnicode mapping for cluster',firstMissing:missing,offset:1});
    // A failed request cannot poison subsequent valid encoding or invent codes.
    expect(f.canEncode('一')).toMatchObject({ok:true,bytes:Uint8Array.of(0,cff?42:1)});
  });

  test('a TrueType Unicode cmap cannot fill a partial PDF ToUnicode',()=>{
    // The fixture's Unicode cmap includes i at GID6, but the PDF labels only S.
    const f=createFontCoverage({subtype:'TrueType',flags:32,encoding:'WinAnsiEncoding',program:tinyTtf(),
      toUnicode:'1 beginbfchar <53> <0053> endbfchar'});
    expect(f.canEncode('Si')).toEqual({ok:false,reason:'no ToUnicode mapping for cluster',firstMissing:'i',offset:1});
    expect(f.canEncode('S')).toMatchObject({ok:true,bytes:Uint8Array.of(83)});
  });

  test('missing glyph-name labels identify the simple font encoding',()=>{
    const f=createFontCoverage({subtype:'TrueType',flags:32,encoding:'WinAnsiEncoding',program:tinyTtf()});
    expect(f.canEncode('S试')).toEqual({ok:false,reason:'no font encoding mapping for cluster',firstMissing:'试',offset:1});
    expect(f.canEncode('Si')).toMatchObject({ok:true,bytes:Uint8Array.of(83,105)});
  });

  test('ligature labels do not authorize component scalars',()=>{
    const f=cid({toUnicode:'1 beginbfchar <0001> <00660069> endbfchar'});
    expect(f.canEncode('fi')).toMatchObject({ok:true,bytes:Uint8Array.of(0,1)});
    expect(f.canEncode('f')).toEqual({ok:false,reason:'no ToUnicode mapping for cluster',firstMissing:'f',offset:0});
  });

  test('a grapheme miss preserves UTF-16 offsets after a supplementary label',()=>{
    const f=cid({toUnicode:'2 beginbfchar <0001> <4e00> <0002> <d83dde00> endbfchar'});
    expect(f.canEncode('一😀试\u0301')).toEqual({ok:false,reason:'no ToUnicode mapping for cluster',firstMissing:'试\u0301',offset:3});
  });

  test('a miss follows the furthest reachable DP path',()=>{
    const f=cid({toUnicode:'3 beginbfchar <0001> <00610062> <0002> <0061> <0003> <00620063> endbfchar'});
    expect(f.canEncode('abcz')).toEqual({ok:false,reason:'no ToUnicode mapping for cluster',firstMissing:'z',offset:3});
  });

  test('mapped glyph and font-wide failures keep the proven refusal',()=>{
    expect(cid({cidToGid:new Uint8Array(4)}).canEncode('一')).toMatchObject({ok:false,reason:'.notdef (GID 0)'});
    expect(cid({encoding:{cmap:'1 begincidchar <0002> 1 endcidchar'}}).canEncode('一'))
      .toMatchObject({ok:false,reason:'code not mapped to CID'});
    expect(cid({program:undefined}).canEncode('试')).toMatchObject({ok:false,reason:'font program not embedded'});
  });
});
