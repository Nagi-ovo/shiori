import {PDFDict,PDFName} from 'pdf-lib';
import {type1Fixture} from './type1Wiring.test-support';
import {nums,widthChar} from '../fontCoverage/fixtures/type1';

/** Embedded source with genuine ink below a tight cover. A descriptor for
 * an unembedded Courier substitute cannot authorize a reflow ink mask. */
export async function embeddedOverflowPage(stream='BT /F1 10 Tf 14 TL 50 100 Td (ABCDE) Tj ET',bottom=-400){
 const hull=Uint8Array.from([...nums(0,600),13,...nums(0,bottom),21,...nums(600,0),5,...nums(0,800-bottom),5,...nums(-600,0),5,9,14]);
 const f=await type1Fixture({stream,widths:Array(26).fill(600),
  programOptions:{glyphs:{'.notdef':widthChar(0),...Object.fromEntries([...'ABCDEZ'].map(ch=>[ch,hull]))}}});
 f.font.delete(PDFName.of('ToUnicode'));f.font.set(PDFName.of('LastChar'),f.doc.context.obj(90));
 const descriptor=f.font.lookup(PDFName.of('FontDescriptor'),PDFDict);
 descriptor.set(PDFName.of('FontBBox'),f.doc.context.obj([0,bottom,600,800]));
 descriptor.set(PDFName.of('Ascent'),f.doc.context.obj(800));descriptor.set(PDFName.of('Descent'),f.doc.context.obj(bottom));
 return f;
}
