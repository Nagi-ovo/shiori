import {expect,test} from 'bun:test';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {PDFName} from 'pdf-lib';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {applyContentTextEdits} from './apply';
import {verticalFixture,verticalText} from './vertical.fixture.test';
import {popplerVerticalOrigins} from './verticalOracle.fixture.test';
import {compareRetypesetRaster} from '../../../../scripts/pdf-corpus/retypesetRaster';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';

// Failure list: horizontal displacement in WMode 1; wrong origin sign;
// DW2 and both W2 forms; TJ/Tc/Tz/Ts/CTM; missing subset glyphs;
// sideways substitution; wrap towards +X; stale labels; clip/crop escape;
// overlapping fixed ink; malformed/fractional metrics; partial source columns;
// mixed horizontal/vertical resources; unsupported orientation and glyph forms.
const output='test-artifacts/r24-vert/native';
const loadFont=(name:string)=>readFile(`src/assets/fonts/${name}`);
for(const metrics of [false,true])test(`Identity-V Japanese uses proved vertical origins and advances (${metrics?'W2':'defaults'})`,async()=>{
 const f=await verticalFixture({metrics}),before=await f.doc.save();
 const result=await applyContentTextEdits(f.page,[f.edit],{loadFont});
 expect(result.outcomes[0]).toMatchObject({mode:'retypeset'});
 await mkdir(output,{recursive:true});const name=metrics?'w2':'defaults';
 await writeFile(`${output}/${name}.before.pdf`,before);const after=await f.doc.save();await writeFile(`${output}/${name}.after.pdf`,after);
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const a=native.inspectPage(before,0,true),b=native.inspectPage(after,0,true);
  expect(b.text.replace(/\s/gu,'')).toBe(f.edit.text);
  const official=compareRetypesetRaster(a,b,a.glyphs,b.glyphs);
  expect(official.changedPixelsOutsideRetypesetMask).toBe(0);
  const popplerOrigins=popplerVerticalOrigins(`${output}/${name}.after.pdf`,b);
  const original=a.glyphs,actual=b.glyphs;
  expect(actual).toHaveLength(Array.from(f.edit.text).length);
  // Each output label retains its own CID-specific origin, at the new pen.
  const point=new Map(original.map(g=>[g.text,g]));let pen=210;
  const rows=[];
  for(const g of actual){const old=point.get(g.text)!;
   // Source pen positions follow W2, not glyph ink boxes.
   const code=f.code(g.text),cid=parseInt(code.slice(1,-1),16);
   const [advance,vx,vy]=metrics?(cid===1?[-1200,450,850]:cid===2||cid===3?[-1050,500,880]:[-1100,500,900]):[-1000,500,880];
   expect(g.origin[0]).toBeCloseTo(210-vx!*16/1000,3);expect(g.origin[1]).toBeCloseTo(pen-vy!*16/1000,3);
   expect(g.inkPixels).toBeGreaterThan(0);rows.push({text:g.text,origin:g.origin,sourceOrigin:old.origin});pen+=advance!*16/1000;
  }
  let outside=0,changed=0;const mask=f.edit.coverRects[0]!,w=Math.round(a.width*2);
  for(let i=0;i<a.pixels!.length;i+=4)if(a.pixels!.readUInt32LE(i)!==b.pixels!.readUInt32LE(i)){
   changed++;const x=(i/4)%w/2,y=a.height-Math.floor(i/4/w)/2;
   if(x<mask.x||x>=mask.x+mask.w||y<mask.y||y>mask.y+mask.h)outside++;
  }
  expect(changed).toBeGreaterThan(0);expect(outside).toBe(0);
  const text=spawnSync('pdftotext',['-layout',`${output}/${name}.after.pdf`,'-'],{encoding:'utf8'});expect(text.status).toBe(0);expect(text.stdout.replace(/\s/gu,'')).toBe(f.edit.text);
  expect(spawnSync('qpdf',['--check',`${output}/${name}.after.pdf`]).status).toBe(0);
  await writeFile(`${output}/${name}.json`,JSON.stringify({command:'bun test src/pdf/export/contentText/vertical.native.test.ts',outcome:result.outcomes[0],official,popplerOrigins,rows,changedPixels:changed,changedPixelsOutsideMask:outside,popplerText:text.stdout},null,2));
 }finally{native.close();}
},60_000);

test('vertical subset fallback remains Identity-V with explicit vertical metrics',async()=>{
 const f=await verticalFixture(),edit={...f.edit,text:'日本新かな'},before=await f.doc.save();
 const result=await applyContentTextEdits(f.page,[edit],{loadFont});expect(result.outcomes[0]).toMatchObject({mode:'retypeset'});
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');try{
  const page=native.inspectPage(await f.doc.save(),0,true);expect(page.text.replace(/\s/gu,'')).toBe(edit.text);
  expect(page.glyphs.every(g=>g.inkPixels!>0)).toBe(true);
  const fresh=page.glyphs.find(g=>g.text==='新')!;expect(fresh.origin[0]).toBeCloseTo(202,3);expect(fresh.origin[1]).toBeLessThan(180);
  const original=native.inspectPage(before,0,true),official=compareRetypesetRaster(original,page,original.glyphs,page.glyphs);expect(official.changedPixelsOutsideRetypesetMask).toBe(0);
  await mkdir(output,{recursive:true});await writeFile(`${output}/fallback.before.pdf`,before);await writeFile(`${output}/fallback.after.pdf`,await f.doc.save());
  const origins=popplerVerticalOrigins(`${output}/fallback.after.pdf`,page);await writeFile(`${output}/fallback.json`,JSON.stringify({official,origins,outcome:result.outcomes[0]},null,2));
 }finally{native.close();}
});

test('vertical wrapping moves to the left and keeps following text stationary',async()=>{
 const f=await verticalFixture({stream:code=>`BT /V1 16 Tf 1 0 0 1 210 210 Tm ${code(verticalText)} Tj 1 0 0 1 250 40 Tm ${code('日')} Tj ET`});
 const edit={...f.edit,text:'日本語かな日本語かな'},native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{const bytes=await f.doc.save(),before=native.inspectPage(bytes,0,true);const result=await applyContentTextEdits(f.page,[edit],{loadFont});expect(result.outcomes[0]).toMatchObject({mode:'retypeset'});
  const saved=await f.doc.save(),after=native.inspectPage(saved,0,true),last=after.glyphs.at(-1)!;expect(last.origin).toEqual(before.glyphs.at(-1)!.origin);
  expect(after.glyphs.slice(0,-1).some(g=>g.origin[0]<190)).toBe(true);
  const official=compareRetypesetRaster(before,after,before.glyphs.slice(0,-1),after.glyphs.slice(0,-1));expect(official.changedPixelsOutsideRetypesetMask).toBe(0);
  await mkdir(output,{recursive:true});await writeFile(`${output}/wrap.before.pdf`,bytes);await writeFile(`${output}/wrap.after.pdf`,saved);
  const origins=popplerVerticalOrigins(`${output}/wrap.after.pdf`,after);await writeFile(`${output}/wrap.json`,JSON.stringify({official,origins,outcome:result.outcomes[0]},null,2));
 }finally{native.close();}
});
for(const kind of ['crop','clip','obstacle','fractional','malformed','wide-default','stale','complex']as const)test(`vertical ${kind} refuses atomically with a specific reason`,async()=>{
 const f=await verticalFixture({stream:code=>`${kind==='clip'?'q 200 120 20 110 re W n ':''}BT /V1 16 Tf 1 0 0 1 210 210 Tm ${code(verticalText)} Tj ET ${kind==='obstacle'?'0 0 0 rg 202 130 14 80 re f':''}${kind==='clip'?' Q':''}`});
 const edit={...f.edit,text:verticalText.repeat(2)};
 // The blocker must constrain fitted in-column output as well as a wrap.
 if(kind==='crop')f.page.setCropBox(200,130,100,110);
 if(kind==='fractional')f.child.set(PDFName.of('DW2'),f.doc.context.obj([880.5,-1000]));
 if(kind==='malformed')f.child.set(PDFName.of('W2'),f.doc.context.obj([1,[-1000,500]]));
 if(kind==='wide-default'){f.child.delete(PDFName.of('W'));f.child.set(PDFName.of('DW'),f.doc.context.obj(65536));}
 if(kind==='stale')edit.originalText='違う';
 if(kind==='complex')edit.text='「日本」';
 const before=inspectRunPage(f.page),resources=f.page.node.Resources(),count=f.doc.context.enumerateIndirectObjects().length;
 const result=await applyContentTextEdits(f.page,[edit],{loadFont});expect(result.outcomes[0]?.mode).toBe('unsupported');expect(result.outcomes[0]?.detail).toContain(kind==='stale'?'source':kind==='complex'?'glyph':kind==='fractional'||kind==='malformed'||kind==='wide-default'?'metrics':kind);
 expect(inspectRunPage(f.page)).toEqual(before);expect(f.page.node.Resources()).toBe(resources);expect(f.doc.context.enumerateIndirectObjects()).toHaveLength(count);
});

test('vertical TJ, spacing, rise, horizontal scaling and CTM preserve an untouched suffix origin',async()=>{
 const f=await verticalFixture({stream:code=>`q 1.2 0 0 .8 0 0 cm BT /V1 16 Tf -2 Tc 80 Tz 3 Ts 1 0 0 1 175 240 Tm [${code('日本')} 125 ${code('語かな')}] TJ ${code('日')} Tj ET Q`});
 const box={x:180,y:122,w:50,h:88},edit={...f.edit,rect:box,coverRects:[box],text:'語本日かな'};
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{const before=native.inspectPage(await f.doc.save()),result=await applyContentTextEdits(f.page,[edit],{loadFont});expect(result.outcomes[0]).toMatchObject({mode:'retypeset'});
 const after=native.inspectPage(await f.doc.save());expect(after.glyphs.at(-1)!.origin[0]).toBeCloseTo(before.glyphs.at(-1)!.origin[0],4);expect(after.glyphs.at(-1)!.origin[1]).toBeCloseTo(before.glyphs.at(-1)!.origin[1],4);
 expect(after.glyphs.slice(0,-1).map(g=>g.text).join('')).toBe(edit.text);
 }finally{native.close();}
});

test('an embedded two-byte WMode 1 CMap keeps opaque codes and uses mapped CID W2',async()=>{
 const f=await verticalFixture({metrics:true});
 f.raw.set(PDFName.of('Encoding'),f.doc.context.register(f.doc.context.stream('/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Local-V def /CMapType 1 def /WMode 1 def 1 begincodespacerange <0000> <ffff> endcodespacerange 1 begincidrange <0000> <ffff> 0 endcidrange endcmap CMapName currentdict /CMap defineresource pop end end',{Type:'CMap',CMapName:'Local-V',WMode:1,CIDSystemInfo:{Registry:'Adobe',Ordering:'Identity',Supplement:0}})));
 const result=await applyContentTextEdits(f.page,[f.edit],{loadFont});expect(result.outcomes[0]).toMatchObject({mode:'retypeset'});
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');try{expect(native.inspectPage(await f.doc.save()).text.replace(/\s/gu,'')).toBe(f.edit.text);}finally{native.close();}
});

for(const kind of ['style','mixed','alternate','orientation','mask']as const)test(`vertical ${kind} keeps its precise refusal and source bytes`,async()=>{
 const f=await verticalFixture({stream:code=>`BT /V1 16 Tf ${kind==='orientation'?'0 1 -1 0 210 100':'1 0 0 1 210 210'} Tm ${code(verticalText)} Tj ET`});
 const edit={...f.edit,text:kind==='alternate'?'日本っかな':f.edit.text};
 if(kind==='orientation'){edit.coverRects=[{x:0,y:0,w:300,h:240}];edit.rect=edit.coverRects[0]!;}
 if(kind==='style')edit.fontSize=20;
 if(kind==='mixed')edit.text='日本12かな';
 if(kind==='mask')edit.text=verticalText.repeat(6);
 const before=inspectRunPage(f.page),count=f.doc.context.enumerateIndirectObjects().length;
 const result=await applyContentTextEdits(f.page,[edit],{loadFont});expect(result.outcomes[0]?.mode).toBe('unsupported');expect(result.outcomes[0]?.detail).toContain(kind==='mixed'||kind==='alternate'?'glyph':kind);
 expect(inspectRunPage(f.page)).toEqual(before);expect(f.doc.context.enumerateIndirectObjects()).toHaveLength(count);
});

test('saved production export rewrites Identity-V Japanese and passes the official raster mask',async()=>{
 const {exportPdf}=await import('../exportPdf');const {model}=await import('./fixtures.test-support');
 const f=await verticalFixture(),before=await f.doc.save();
 const document=model([f.edit]);document.pages[0]!.heightPt=240;
 const result=await exportPdf(before,document,{mode:'flatten',inPlaceFallback:{loadFont}});
 expect(result.contentTextOutcomes?.[0]).toMatchObject({mode:'retypeset'});expect(result.unexcisedEdits).toBe(0);
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const a=native.inspectPage(before,0,true),b=native.inspectPage(result.bytes,0,true);
  expect(b.text.replace(/\s/gu,'')).toBe(f.edit.text);expect(b.glyphs).toHaveLength(5);
  const official=compareRetypesetRaster(a,b,a.glyphs,b.glyphs);expect(official.changedPixelsOutsideRetypesetMask).toBe(0);
  await mkdir(output,{recursive:true});await writeFile(`${output}/export.before.pdf`,before);await writeFile(`${output}/export.after.pdf`,result.bytes);
  const origins=popplerVerticalOrigins(`${output}/export.after.pdf`,b);
  await writeFile(`${output}/export.json`,JSON.stringify({command:'bun test src/pdf/export/contentText/vertical.native.test.ts',outcome:result.contentTextOutcomes?.[0],official,origins},null,2));
 }finally{native.close();}
},60_000);

test('deleting a vertical span preserves subsequent text through empty-string TJ compensation',async()=>{
 const f=await verticalFixture({stream:code=>`BT /V1 16 Tf 1 0 0 1 210 210 Tm ${code(verticalText)} Tj 0 -140 Td ${code('日')} Tj ET`});
 const edit={...f.edit,text:''},native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{const before=native.inspectPage(await f.doc.save()),result=await applyContentTextEdits(f.page,[edit],{loadFont});expect(result.outcomes[0]).toMatchObject({mode:'retypeset'});
 const after=native.inspectPage(await f.doc.save());expect(after.glyphs).toHaveLength(1);expect(after.glyphs[0]!.origin).toEqual(before.glyphs.at(-1)!.origin);
 }finally{native.close();}
});

test('vertical local CMap maps nonidentity character codes to CID-specific W2 without using Unicode as CID',async()=>{
 const f=await verticalFixture({metrics:true});
 const mapping=Array.from(verticalText,c=>({text:c,cid:parseInt(f.code(c).slice(1,-1),16)}));
 const code=(c:string)=>(mapping.find(m=>m.text===c)!.cid+256).toString(16).padStart(4,'0');
 const cmap='/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Local-V def /CMapType 1 def /WMode 1 def 1 begincodespacerange <0000> <ffff> endcodespacerange '+mapping.length+' begincidchar '+mapping.map(m=>`<${code(m.text)}> ${m.cid}`).join(' ')+' endcidchar endcmap CMapName currentdict /CMap defineresource pop end end';
 f.raw.set(PDFName.of('Encoding'),f.doc.context.register(f.doc.context.stream(cmap,{Type:'CMap',CMapName:'Local-V',WMode:1})));
 const unicode='/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Unicode def /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange '+mapping.length+' beginbfchar '+mapping.map(m=>`<${code(m.text)}> <${m.text.charCodeAt(0).toString(16)}>`).join(' ')+' endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
 f.raw.set(PDFName.of('ToUnicode'),f.doc.context.register(f.doc.context.stream(unicode)));
 f.page.node.set(PDFName.of('Contents'),f.doc.context.register(f.doc.context.stream(`BT /V1 16 Tf 1 0 0 1 210 210 Tm <${Array.from(verticalText,code).join('')}> Tj ET`)));
 const result=await applyContentTextEdits(f.page,[f.edit],{loadFont});expect(result.outcomes[0]).toMatchObject({mode:'retypeset'});
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');try{
  const page=native.inspectPage(await f.doc.save());expect(page.text.replace(/\s/gu,'')).toBe(f.edit.text);
  expect(page.glyphs[0]!.origin[0]).toBeCloseTo(202,3);expect(page.glyphs[0]!.origin[1]).toBeCloseTo(210-880*16/1000,3);
 }finally{native.close();}
});

const verticalTtf=process.env.SHIORI_VERTICAL_TTF;
test.skipIf(!verticalTtf)('embedded Japanese CIDFontType2 Identity-V retains native glyph identity and placement',async()=>{
 const f=await verticalFixture({fontData:await readFile(verticalTtf!),metrics:true});
 const before=await f.doc.save(),native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const a=native.inspectPage(before,0,true),result=await applyContentTextEdits(f.page,[f.edit],{loadFont});expect(result.outcomes[0]).toMatchObject({mode:'retypeset'});
  const after=await f.doc.save(),b=native.inspectPage(after,0,true);expect(b.text.replace(/\s/gu,'')).toBe(f.edit.text);
  for(const g of b.glyphs){const source=a.glyphs.find(o=>o.text===g.text)!;expect(g.nativePath).toEqual(source.nativePath);expect(g.fontHash).toBe(source.fontHash);expect(g.inkPixels).toBeGreaterThan(0);}
  const official=compareRetypesetRaster(a,b,a.glyphs,b.glyphs);expect(official.changedPixelsOutsideRetypesetMask).toBe(0);
  await mkdir(output,{recursive:true});await writeFile(`${output}/truetype.before.pdf`,before);await writeFile(`${output}/truetype.after.pdf`,after);
  const origins=popplerVerticalOrigins(`${output}/truetype.after.pdf`,b);
  await writeFile(`${output}/truetype.json`,JSON.stringify({command:'SHIORI_VERTICAL_TTF=<Japanese TrueType font> bun test src/pdf/export/contentText/vertical.native.test.ts',source:verticalTtf,outcome:result.outcomes[0],official,origins},null,2));
 }finally{native.close();}
});

test('vertical fallback refuses an in-place source-stream change during asynchronous font loading',async()=>{
 const {PDFRawStream}=await import('pdf-lib');
 const f=await verticalFixture(),contents=f.page.node.Contents();expect(contents).toBeInstanceOf(PDFRawStream);
 const originalResources=f.page.node.Resources(),count=f.doc.context.enumerateIndirectObjects().length;
 let changed:Uint8Array|undefined;
 const result=await applyContentTextEdits(f.page,[{...f.edit,text:'日本新かな'}],{loadFont:async name=>{
  const data=(contents as InstanceType<typeof PDFRawStream>).getContents(),at=new TextDecoder().decode(data).indexOf('210');expect(at).toBeGreaterThan(0);
  data[at+1]=51;changed=data.slice();return loadFont(name);
 }});
 expect(result.outcomes[0]?.mode).toBe('unsupported');expect(result.outcomes[0]?.detail).toContain('source');
 expect((contents as InstanceType<typeof PDFRawStream>).getContents()).toEqual(changed!);expect(f.page.node.Resources()).toBe(originalResources);
 expect(f.doc.context.enumerateIndirectObjects()).toHaveLength(count);
});
