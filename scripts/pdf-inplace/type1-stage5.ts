// Reproduce: bun scripts/pdf-inplace/type1-stage5.ts
// Isolated opt-in native fixture. Does not enable either production flag.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {PDFDocument,PDFName} from 'pdf-lib';
import {tinyType1,nums} from '../../src/pdf/export/fontCoverage/fixtures/type1';
import {fontCoverageFromDict} from '../../src/pdf/export/fontCoverage/pdfLibAdapter';
import {assertType1Source,surgicalType1Encoder} from '../../src/pdf/export/fontCoverage/type1Surgical';
import {contentFontInfo} from '../../src/pdf/export/contentStreamEdit/glyphWidths';
import {replaceRuns,sourceFingerprint} from '../../src/pdf/export/contentStreamEdit/replaceRun';
import {openPdfium} from './nativePdfium';
const dir='test-artifacts/type1-stage5';await mkdir(dir,{recursive:true});
// Hand-specified filled rectangles, deliberately distinct from .notdef and
// from one another. The pinned native path API returns em coordinates (with 1/4096 quantization).
const rect=(w:number,h:number)=>Uint8Array.from([...nums(0,600),13,...nums(0,0),21,...nums(w,0),5,...nums(0,h),5,...nums(-w,0),5,9,14]);
const glyphs={'.notdef':rect(100,100),A:rect(400,700),B:rect(300,500)};
const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
try {
  const cases=[];
  for(const lenIV of [-1,0,1,4]){
    const fixture=tinyType1({lenIV,glyphs}),doc=await PDFDocument.create(),ctx=doc.context,page=doc.addPage([300,160]);
    const font=ctx.obj({Type:'Font',Subtype:'Type1',BaseFont:'Tiny',FirstChar:65,LastChar:66,Widths:[600,600],
      ToUnicode:ctx.register(ctx.flateStream('2 beginbfchar <41> <0041> <42> <0042> endbfchar')),
      FontDescriptor:ctx.obj({Type:'FontDescriptor',FontName:'Tiny',Flags:32,FontBBox:[0,0,600,700],Ascent:700,Descent:0,CapHeight:700,ItalicAngle:0,StemV:80,
        FontFile:ctx.register(ctx.flateStream(fixture.program,{Length1:fixture.length1,Length2:fixture.length2,Length3:fixture.length3}))})});
    const ref=ctx.register(font);page.node.set(PDFName.of('Resources'),ctx.obj({Font:{F1:ref}}));
    const source=new TextEncoder().encode('BT /F1 12 Tf 30 90 Td (ABBA) Tj ET');
    page.node.set(PDFName.of('Contents'),ctx.register(ctx.flateStream(source)));
    const before=await doc.save(),coverage=fontCoverageFromDict(font,{sourceReuse:true});
    assertType1Source(coverage,[Uint8Array.of(65),Uint8Array.of(66)]);
    const info=contentFontInfo(font,{sourceReuse:true});assert(info.ok);
    const result=replaceRuns(source,[{...info,resourceName:'F1',objectId:ref.toString(),unicodeByCode:new Map([[65,'A'],[66,'B']]),canEncode:surgicalType1Encoder(coverage)}],{
      sourceHash:sourceFingerprint(source),edits:[{fontResource:'F1',fontObject:ref.toString(),opIndex:3,itemIndex:-1,byteStart:0,byteEnd:3,expected:Uint8Array.of(65,66,66),replacement:'A'}]});
    assert(result.ok,JSON.stringify(result));page.node.set(PDFName.of('Contents'),ctx.register(ctx.flateStream(result.bytes)));
    const after=await doc.save();await writeFile(`${dir}/lenIV-${lenIV}-before.pdf`,before);await writeFile(`${dir}/lenIV-${lenIV}-after.pdf`,after);
    const a=native.inspectPage(before,0,true),b=native.inspectPage(after,0,true);
    assert.equal(a.glyphs.map(g=>g.text).join(''),'ABBA');assert.equal(b.glyphs.map(g=>g.text).join(''),'AA');
    const drift=Math.hypot(a.glyphs[3]!.origin[0]-b.glyphs[1]!.origin[0],a.glyphs[3]!.origin[1]-b.glyphs[1]!.origin[1]);assert(drift<=0.005,`suffix drift ${drift}`);
    assert.deepEqual(a.glyphs[0]!.origin,b.glyphs[0]!.origin);
    const path=b.glyphs[0]!.nativePath;assert(path?.length,'missing native outline');
    const xs=path.map(s=>s.point[0]!),ys=path.map(s=>s.point[1]!);
    const bounds=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
    const expectedPath=[[2,0,0,false],[0,0.4,0,false],[0,0.4,0.7,false],[0,0,0.7,false],[0,0,0,true]] as const;
    assert.equal(path.length,expectedPath.length);
    for(const [i,expected]of expectedPath.entries()){
      const segment=path[i]!;assert.equal(segment.type,expected[0]);assert.equal(segment.closed,expected[3]);
      assert(Math.abs(segment.point[0]!-expected[1])<=1/4096&&Math.abs(segment.point[1]!-expected[2])<=1/4096,'unexpected A outline');
    }
    assert(b.glyphs[0]!.inkPixels!>0,'blank replacement');
    let outsidePixels=0;
    const pixelWidth=Math.round(a.width*2),pixelHeight=Math.round(a.height*2);
    for(let y=0;y<pixelHeight;y++)for(let x=0;x<pixelWidth;x++){
      if(x/2>=29&&x/2<=50&&a.height-y/2>=89&&a.height-y/2<=100)continue;
      const offset=(y*pixelWidth+x)*4;
      if([0,1,2,3].some(c=>a.pixels![offset+c]!==b.pixels![offset+c]))outsidePixels++;
    }
    assert.equal(outsidePixels,0,'pixels changed outside the edited run');
    cases.push({lenIV,drift,outsidePixels,bounds,nativePath:path,inkPixels:b.glyphs[0]!.inkPixels,beforeText:a.text,afterText:b.text});
  }
  await writeFile(`${dir}/report.json`,JSON.stringify({command:'bun scripts/pdf-inplace/type1-stage5.ts',cases,productionEnabled:false},null,2));
  console.log(JSON.stringify({cases:cases.length,maxDrift:Math.max(...cases.map(c=>c.drift)),report:`${dir}/report.json`}));
}finally{native.close();}
