import { expect, test } from 'bun:test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { collectFontCoverage } from './pdfLibAdapter';
import { tinyTtf } from './fixtures/programs';

test('distinct same-BaseFont subsets retain object identity and page aliases',async()=>{
  const doc=await PDFDocument.create(),ctx=doc.context;
  const font=(code:string) => ctx.register(ctx.obj({Type:'Font',Subtype:'TrueType',BaseFont:'ABCDEF+Sans',Encoding:'WinAnsiEncoding',
    ToUnicode:ctx.register(ctx.flateStream(`1 beginbfchar <${code}> <0053> endbfchar`)),
    FontDescriptor:ctx.register(ctx.obj({Type:'FontDescriptor',Flags:32,FontFile2:ctx.register(ctx.flateStream(tinyTtf()))}))}));
  const a=font('53'),b=font('64');
  doc.addPage().node.set(PDFName.of('Resources'),ctx.obj({Font:{F1:a,F2:b,Alias:a}}));
  doc.addPage().node.set(PDFName.of('Resources'),ctx.obj({Font:{F1:a}}));
  const fonts=collectFontCoverage(await PDFDocument.load(await doc.save()));
  expect(fonts).toHaveLength(2);
  expect(fonts[0]!.objectRef).toBe(a.toString()); expect(fonts[1]!.objectRef).toBe(b.toString());
  expect(fonts[0]!.resources).toEqual([{page:1,name:'F1',path:[]},{page:1,name:'Alias',path:[]},{page:2,name:'F1',path:[]}]);
  expect(fonts[0]!.subsetTag).toBe('ABCDEF');
  expect(fonts[0]!.canEncode('S').ok).toBe(true); expect(fonts[1]!.canEncode('S').ok).toBe(false);
});

test('Form resources are discovered without looping over recursive forms',async()=>{
  const doc=await PDFDocument.create(),ctx=doc.context;
  const f=ctx.register(ctx.obj({Type:'Font',Subtype:'Type1',BaseFont:'Helvetica'}));
  const resources=ctx.obj({Font:{Inner:f}}),form=ctx.flateStream('',{Type:'XObject',Subtype:'Form',BBox:[0,0,20,20],Resources:resources});
  const ref=ctx.register(form); resources.set(PDFName.of('XObject'),ctx.obj({Self:ref}));
  doc.addPage().node.set(PDFName.of('Resources'),ctx.obj({XObject:{Form:ref}}));
  const fonts=collectFontCoverage(doc);
  expect(fonts).toHaveLength(1); expect(fonts[0]!.resources).toEqual([{page:1,name:'Inner',path:['Form']}]);
});

test('raw FontFile segment lengths, widths and matrices reach pure Type1 proof',async()=>{
  const {tinyType1}=await import('./fixtures/type1');const {fontCoverageFromDict}=await import('./pdfLibAdapter');
  const f=tinyType1(),doc=await PDFDocument.create(),ctx=doc.context;
  const font=ctx.obj({Type:'Font',Subtype:'Type1',BaseFont:'Tiny',FirstChar:65,LastChar:66,Widths:[600,600],
    ToUnicode:ctx.register(ctx.flateStream('2 beginbfchar <41> <0041> <42> <0042> endbfchar')),
    FontDescriptor:ctx.obj({FontFile:ctx.register(ctx.flateStream(f.program,{Length1:f.length1,Length2:f.length2,Length3:f.length3}))})});
  expect(fontCoverageFromDict(font,{sourceReuse:true}).canEncode('A')).toMatchObject({ok:true});
});
