import { PDFDocument, PDFName, type PDFDict } from 'pdf-lib';
import { tinyCff, tinyTtf } from '../../src/pdf/export/fontCoverage/fixtures/programs';
/** Fixtures deliberately include incorrect ToUnicode mappings: reports must
 * record refusals instead of equating extractable text with glyph coverage. */
export async function coverageFixtures():Promise<Map<string,Uint8Array>> {
  const out=new Map<string,Uint8Array>();
  for(const scenario of ['subset','distinct-subsets','cid-map','cid-default','embedded-cmap','cid-cff','simple-cff','standard14','type3','truncated']) {
    const doc=await PDFDocument.create(),ctx=doc.context,page=doc.addPage();
    const cid=scenario.startsWith('cid-') || scenario==='embedded-cmap';
    const cff=scenario.endsWith('cff');
    const tounicode=cid?'2 beginbfchar <0001> <0053> <002a> <0041> endbfchar':'4 beginbfchar <53> <0053> <61> <0061> <6e> <006e> <64> <0064> endbfchar';
    const descriptor=ctx.register(ctx.obj({Type:'FontDescriptor',FontName:'ABCDEF+Sans',Flags:32,FontBBox:[0,0,1000,1000],ItalicAngle:0,Ascent:800,Descent:-200,CapHeight:700,StemV:80,
      [cff?'FontFile3':'FontFile2']:ctx.register(ctx.flateStream(scenario==='truncated'?Uint8Array.of(0,1,0,0):cff?tinyCff(cid):tinyTtf(),cff?{Subtype:cid?'CIDFontType0C':'Type1C'}:{}))}));
    let font:PDFDict;
    let content='BT /F1 12 Tf 20 100 Td <53616e64> Tj ET';
    if(cid) {
      const map=new Uint8Array(86);map[85]=7;
      const child=ctx.register(ctx.obj({Type:'Font',Subtype:cff?'CIDFontType0':'CIDFontType2',BaseFont:'ABCDEF+Sans',FontDescriptor:descriptor,CIDSystemInfo:{Registry:ctx.obj('Adobe'),Ordering:ctx.obj('Identity'),Supplement:0},DW:500,
        ...(scenario==='cid-map'?{CIDToGIDMap:ctx.register(ctx.flateStream(map))}:{})}));
      font=ctx.obj({Type:'Font',Subtype:'Type0',BaseFont:'ABCDEF+Sans',DescendantFonts:[child],
        Encoding:scenario==='embedded-cmap'?ctx.register(ctx.flateStream('1 begincodespacerange <00> <ff> endcodespacerange 1 begincidchar <41> 7 endcidchar')):'Identity-H',
        ToUnicode:ctx.register(ctx.flateStream(scenario==='embedded-cmap'?'1 beginbfchar <41> <0041> endbfchar':tounicode))});
      content=`BT /F1 12 Tf 20 100 Td <${scenario==='embedded-cmap'?'41':'0001002a'}> Tj ET`;
    } else if(scenario==='standard14') {
      font=ctx.obj({Type:'Font',Subtype:'Type1',BaseFont:'Helvetica',Encoding:'WinAnsiEncoding'});
    } else if(scenario==='type3') {
      font=ctx.obj({Type:'Font',Subtype:'Type3',FontBBox:[0,0,500,700],FontMatrix:[0.001,0,0,0.001,0,0],FirstChar:83,LastChar:83,Widths:[500],Encoding:{Differences:[83,'S']},
        CharProcs:{S:ctx.register(ctx.flateStream('500 0 d0 0 0 100 100 re f'))},ToUnicode:ctx.register(ctx.flateStream('1 beginbfchar <53> <0053> endbfchar'))});
      content='BT /F1 12 Tf 20 100 Td <53> Tj ET';
    } else {
      font=ctx.obj({Type:'Font',Subtype:cff?'Type1':'TrueType',BaseFont:'ABCDEF+Sans',FirstChar:0,LastChar:255,Widths:new Array(256).fill(500),Encoding:'WinAnsiEncoding',FontDescriptor:descriptor,
        ToUnicode:ctx.register(ctx.flateStream(cff?'1 beginbfchar <41> <0041> endbfchar':tounicode))});
      if(cff)content='BT /F1 12 Tf 20 100 Td <41> Tj ET';
    }
    const fonts:Record<string,unknown>={F1:ctx.register(font)};
    if(scenario==='distinct-subsets') {
      const other=font.clone(ctx);other.set(PDFName.of('Encoding'),ctx.obj({BaseEncoding:'WinAnsiEncoding',Differences:[83,'A']}));
      fonts.F2=ctx.register(other);content+=' BT /F2 12 Tf 20 80 Td <53> Tj ET';
    }
    page.node.set(PDFName.of('Resources'),ctx.obj({Font:fonts}));
    page.node.set(PDFName.of('Contents'),ctx.register(ctx.flateStream(content)));
    out.set(scenario,await doc.save());
  }
  return out;
}
