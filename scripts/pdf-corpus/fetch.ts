import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export type CorpusEntry={id:string;url:string;sha256:string;bytes:number;category:string;producer:string;licence:string;licenceEvidence:string;licenceUrl?:string;notes?:string};
export const cacheDir=resolve('test-artifacts/pdf-corpus/cache');
export function verifyPdf(bytes:Uint8Array,entry:Pick<CorpusEntry,'bytes'|'sha256'>) {
 if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw Error('not a PDF response');
 if(bytes.length!==entry.bytes)throw Error('PDF size mismatch');
 if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('PDF hash mismatch');
}
export function samplePages(count:number):number[]{return count<=5?Array.from({length:count},(_,i)=>i):Array.from({length:5},(_,i)=>Math.floor(i*(count-1)/4));}
export async function fetchEntry(entry:CorpusEntry):Promise<Uint8Array> {
 if(!/^[a-zA-Z0-9_.-]+$/.test(entry.id) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !entry.licenceEvidence)throw Error('invalid corpus manifest entry');
 await mkdir(cacheDir,{recursive:true});const path=resolve(cacheDir,`${entry.id}.pdf`);
 try{const bytes=new Uint8Array(await readFile(path));verifyPdf(bytes,entry);return bytes;}catch{/* A corrupt cache is downloaded again and verified before writing. */}
 const response=await fetch(entry.url,{signal:AbortSignal.timeout(90000)});if(!response.ok)throw Error(`PDF download HTTP ${response.status}: ${entry.id}`);
 const bytes=new Uint8Array(await response.arrayBuffer());verifyPdf(bytes,entry);await writeFile(path,bytes);return bytes;
}
export async function readManifest():Promise<CorpusEntry[]>{return JSON.parse(await readFile(new URL('./manifest.json',import.meta.url),'utf8'));}
if(import.meta.main){for(const entry of await readManifest()){await fetchEntry(entry);console.log(`verified ${entry.id}`);}}
