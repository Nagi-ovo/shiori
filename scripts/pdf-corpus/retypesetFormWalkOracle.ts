import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PDFArray,PDFDict,PDFName,PDFRawStream,PDFRef,decodePDFRawStream,type PDFObject,type PDFPage} from 'pdf-lib';
import {readRetypesetStreams} from '../../src/pdf/export/contentText/retypesetForms';
import type {Type1Options} from '../../src/pdf/export/fontCoverage/type1Support';

type Streams=ReturnType<typeof readRetypesetStreams>;
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');

/** Resolve references and sort dictionaries, so copying a Form into another
 * document does not change its identity. Include the complete resource graph:
 * equal text bytes cannot excuse changed BBox/Matrix/fonts/nested Forms.
 * Decoded bytes ignore harmless recompression, never decoding failures. */
export function resourceFingerprint(raw:PDFRawStream|PDFDict){
 const context=raw instanceof PDFRawStream?raw.dict.context:raw.context;
 const seen=new Map<PDFObject,number>();
 const visit=(object:PDFObject):unknown=>{
  if(object instanceof PDFRef){
   const value=context.lookup(object);assert(value,'form-walk unresolved resource');
   return visit(value);
  }
  const prior=seen.get(object);if(prior!==undefined)return ['seen',prior];
  // Track containers only: interned scalar objects are implementation details.
  if(object instanceof PDFDict||object instanceof PDFArray||object instanceof PDFRawStream)seen.set(object,seen.size);
  if(object instanceof PDFRawStream){
   let bytes:Uint8Array,decoded=true;
   try{bytes=object.dict.has(PDFName.of('Filter'))?decodePDFRawStream(object).decode():object.getContents();}
   catch{bytes=object.getContents();decoded=false;}
   return ['stream',decoded,dict(object.dict,decoded?['Length','Filter','DecodeParms']:['Length']),hash(bytes)];
  }
  if(object instanceof PDFDict)return ['dict',dict(object)];
  if(object instanceof PDFArray)return ['array',object.asArray().map(visit)];
  return [object.constructor.name,object.toString()];
 };
 const dict=(value:PDFDict,omit:readonly string[]=[])=>value.entries()
  .filter(([key])=>!omit.includes(key.decodeText())).sort(([a],[b])=>a.toString().localeCompare(b.toString()))
  .map(([key,object])=>[key.toString(),visit(object)]);
 return hash(JSON.stringify(visit(raw)));
}

/** Find the failing Form even when invalid geometry prevented its node from
 * being visited. Paths identify an invocation in this snapshot only. */
function formIssues(streams:Streams){
 const fingerprints=new Map<PDFRawStream,string>();
 return streams.errors.map(error=>{
  const split=error.indexOf(': '),key=error.slice(0,split),reason=error.slice(split+2);
  let raw=streams.nodes.find(node=>node.key===key)?.raw;
  if(!raw){
   const slash=key.lastIndexOf('/'),parent=streams.nodes.find(node=>node.key===key.slice(0,slash));
   const use=parent?.read.walk.ok?parent.read.walk.xobjects.find(use=>use.opIndex===Number(key.slice(slash+1))):undefined;
   const object=use?parent?.page.node.Resources()?.lookupMaybe(PDFName.of('XObject'),PDFDict)?.lookup(PDFName.of(use.name)):undefined;
   if(object instanceof PDFRawStream)raw=object;
  }
  assert(split>=0&&raw?.dict.get(PDFName.of('Subtype'))===PDFName.of('Form'),`retypeset form-walk failed outside an identifiable Form: ${error}`);
  let fingerprint=fingerprints.get(raw);if(!fingerprint){fingerprint=resourceFingerprint(raw);fingerprints.set(raw,fingerprint);}
  return {error,identity:`${reason}\n${fingerprint}`};
 });
}

/** Like r21 qpdf diagnostics, after errors must be a multiset subset of the
 * immutable source's errors on unchanged Forms. Root/unidentified errors fail
 * closed. Passing the source twice permits only identifiable source defects. */
export function compareRetypesetFormWalk(before:PDFPage,after:PDFPage=before,options:Type1Options={}){
 const original=readRetypesetStreams(before,options),actual=before===after?original:readRetypesetStreams(after,options);
 const source=formIssues(original),output=before===after?source:formIssues(actual),available=new Map<string,number>();
 for(const issue of source)available.set(issue.identity,(available.get(issue.identity)??0)+1);
 for(const issue of output){
  const count=available.get(issue.identity)??0;
  assert(count>0,`retypeset form-walk new or rewritten Form defect: ${issue.error}`);
  available.set(issue.identity,count-1);
 }
 // Partial glyphs from an inherited failed Form walk cannot establish ownership
 // or be treated as a complete snapshot. Its entire saved graph was matched.
 const readable=(streams:Streams)=>({...streams,nodes:streams.nodes.filter(node=>node.read.walk.ok)});
 return {before:readable(original),after:readable(actual),formWalkSourceIssues:source.length,formWalkInheritedIssues:output.length};
}
