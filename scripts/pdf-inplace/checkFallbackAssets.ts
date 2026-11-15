// Rerun after `bun run build`: bun scripts/pdf-inplace/checkFallbackAssets.ts
// Exercise the actual Vite-compiled default lazy loader and compare emitted
// font bytes with DOCX's existing assets. Artifacts are independently reviewable.
import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root=resolve('.'),out=join(root,'test-artifacts/pdf-inplace/review-round/asset-probe');
await mkdir(out,{recursive:true});
const entry=join(out,'entry.ts');
await writeFile(entry,`import { fallbackFontUrl, loadBundledFallbackFont } from '${join(root,'src/pdf/export/contentStreamEdit/fallbackAssets.ts')}';
Object.assign(globalThis,{fallbackAssetProbe:{fallbackFontUrl,loadBundledFallbackFont}});\n`);
await build({configFile:false,root,publicDir:false,logLevel:'warn',base:'/',build:{outDir:join(out,'dist'),emptyOutDir:true,assetsInlineLimit:0,minify:false,
  rollupOptions:{input:entry,output:{entryFileNames:'loader.js'}}}});
await import(pathToFileURL(join(out,'dist/loader.js')).href);
const probe=(globalThis as unknown as {fallbackAssetProbe:{fallbackFontUrl:(name:string)=>Promise<string>;loadBundledFallbackFont:(name:string)=>Promise<Uint8Array>}}).fallbackAssetProbe;
const names=['Sans','Serif','Mono'].flatMap(f=>['Regular','Bold','Italic','BoldItalic'].map(s=>`Liberation${f}-${s}.ttf`));
names.push('NotoSansSC-Regular.otf','NotoSansJP-Regular.otf');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const appFiles=await readdir(join(root,'dist/assets'));
const liberationFiles=appFiles.filter(f=>/^Liberation(Sans|Serif|Mono)-.*\.ttf$/.test(f));
assert.equal(liberationFiles.length,12,'app must emit exactly the existing twelve Liberation faces');
const appHashes=new Map<string,string[]>();
for(const file of appFiles.filter(f=>/\.(ttf|otf)$/.test(f))){const h=hash(await readFile(join(root,'dist/assets',file)));appHashes.set(h,[...(appHashes.get(h)??[]),file]);}
const originalFetch=globalThis.fetch,fetches=new Map<string,number>(),rows=[];
globalThis.fetch=(async(url:RequestInfo|URL)=>{
  const file=String(url).split('/').at(-1)!;fetches.set(file,(fetches.get(file)??0)+1);
  return new Response(await readFile(join(out,'dist/assets',file)));
}) as typeof fetch;
try{
  for(const name of names){
    const url=await probe.fallbackFontUrl(name);
    const [a,b]=await Promise.all([probe.loadBundledFallbackFont(name),probe.loadBundledFallbackFont(name)]);
    assert.equal(a,b,'default loader should cache bytes');
    const source=name.endsWith('.ttf')?join(root,'node_modules/@docx-editor.dev/fonts/assets',name):join(root,'src/assets/fonts',name);
    const expected=hash(await readFile(source));assert.equal(hash(a),expected);
    assert.equal(fetches.get(url.split('/').at(-1)!),1,'selected font should be fetched once');
    assert.equal(appHashes.get(expected)?.length,1,'same font bytes must occur once in the app bundle');
    rows.push({name,url,sha256:expected,bytes:a.length,appAsset:appHashes.get(expected)![0],fetches:1,passed:true});
  }
}finally{globalThis.fetch=originalFetch;}
await writeFile(join(out,'report.json'),JSON.stringify({command:'bun run build && bun scripts/pdf-inplace/checkFallbackAssets.ts',liberationAssets:liberationFiles.length,cases:rows,passed:true},null,2));
console.log(JSON.stringify({passed:true,defaultLoaderCases:rows.length,liberationAssets:liberationFiles.length,report:join(out,'report.json')}));
