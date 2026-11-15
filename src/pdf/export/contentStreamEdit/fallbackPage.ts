import { PDFDocument, PDFDict, PDFArray, PDFName, PDFNumber, PDFObjectCopier, type PDFPage } from 'pdf-lib';
import { inspectRunPage, resolveRunFonts, runPageEnvironment, type PageRunResult } from './replaceRunPage';
import { runResourceStamp } from './resourceStamp';
import {RunCompileError} from './runRefusal';
import { replaceRuns } from './replaceRun';
import { pageRunPlan, type PageRunPlan } from './pageRunPlan';
import { fallbackFontName, prepareFallback, type FallbackOptions } from './fallbackFont';

export const replaceRunPageWithFallback=(page:PDFPage,plan:PageRunPlan,options:FallbackOptions={})=>runPage(page,plan,options,true);
export const compileRunPageWithFallback=(page:PDFPage,plan:PageRunPlan,options:FallbackOptions={})=>runPage(page,plan,options,false);
async function runPage(page:PDFPage,plan:PageRunPlan,options:FallbackOptions,install:boolean):Promise<PageRunResult&{usedFallback?:boolean}> {
  const source = inspectRunPage(page);
  if (!source.ok) return source;
  const originalResources = page.node.Resources();
  const originalContents = page.node.get(PDFName.of('Contents'));
  try {
    const resourceStamp = runResourceStamp(page);
    const fonts = resolveRunFonts(page);
    const resolvedPlan = { ...pageRunPlan(plan), ...runPageEnvironment(page) };
    const initial = replaceRuns(source.bytes,fonts,resolvedPlan);
    if(initial.ok || initial.code!=='font-coverage') {
      if (install && initial.ok && initial.bytes !== source.bytes) page.node.set(PDFName.of('Contents'),page.doc.context.register(page.doc.context.flateStream(initial.bytes)));
      return initial;
    }
    const groups = new Map<string,Set<string>>();
    const fontDict = originalResources?.lookupMaybe(PDFName.of('Font'),PDFDict);
    for (const edit of plan.edits) {
      const font = fonts.find(f => f.resourceName === edit.fontResource && f.objectId === edit.fontObject);
      if (!font?.canEncode) return initial;
      if (font.canEncode(edit.replacement).ok) continue;
      const dict = fontDict?.lookupMaybe(PDFName.of(font.resourceName),PDFDict);
      if (!dict) return initial;
      const base = dict.lookupMaybe(PDFName.of('BaseFont'),PDFName)?.decodeText() ?? '';
      const descendant = dict.lookupMaybe(PDFName.of('DescendantFonts'),PDFArray)?.lookup(0,PDFDict);
      const descriptor = (descendant ?? dict).lookupMaybe(PDFName.of('FontDescriptor'),PDFDict);
      const flags = descriptor?.lookupMaybe(PDFName.of('Flags'),PDFNumber)?.asNumber() ?? 0;
      for (const { segment } of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(edit.replacement)) {
        if (font.canEncode(segment).ok) continue;
        const name = fallbackFontName(base,flags,segment);
        const set = groups.get(name) ?? new Set<string>(); set.add(segment); groups.set(name,set);
      }
    }
    if (!groups.size) return initial;
    const scratch = await PDFDocument.create();
    const prepared = [];
    let index = 0;
    for (const [name,clusters] of groups) {
      let resource: string;
      do { resource = `ShioriFb${++index}`; } while (fontDict?.has(PDFName.of(resource)));
      prepared.push(await prepareFallback(scratch,resource,name,[...clusters],options));
    }
    const result = replaceRuns(source.bytes,fonts,{ ...resolvedPlan, fallbackFonts: prepared.map(f => f.resolved) });
    if (!result.ok) return result;
    if(!install)return {...result,usedFallback:true};
    // Awaiting font preparation must never apply an old plan to a newer page.
    const current = inspectRunPage(page);
    if (!current.ok || current.sourceHash !== source.sourceHash || page.node.Resources() !== originalResources || page.node.get(PDFName.of('Contents')) !== originalContents || runResourceStamp(page) !== resourceStamp) {
      return { ok:false, bytes:source.bytes, code:'stale-source', reason:'page changed during fallback preparation' };
    }
    const resources = originalResources?.clone() ?? page.doc.context.obj({});
    const patchedFonts = fontDict?.clone() ?? page.doc.context.obj({});
    const copier = PDFObjectCopier.for(scratch.context,page.doc.context);
    for (const f of prepared) patchedFonts.set(PDFName.of(f.resolved.resourceName),copier.copy(f.ref));
    resources.set(PDFName.of('Font'),patchedFonts);
    const stream = page.doc.context.register(page.doc.context.flateStream(result.bytes));
    page.node.set(PDFName.of('Resources'),resources);
    page.node.set(PDFName.of('Contents'),stream);
    return {...result,usedFallback:true};
  } catch(error){if(!(error instanceof RunCompileError))throw error;return{ok:false,code:error.code,reason:error.message,bytes:source.bytes};}
}
