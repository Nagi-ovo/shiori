import {address} from './retypesetSource';
import type {RetypesetGroup} from './retypesetTypes';

export type RetypesetBatch<T>={keys:Set<string>;members:T[]};
/** Selections can add a superscript/shifted glyph to otherwise identical
 * paragraphs. Shared glyph ownership, rather than equal membership strings,
 * makes those edits one transaction and defers their exact siblings. */
export function addRetypesetBatch<T>(batches:RetypesetBatch<T>[],group:RetypesetGroup,member:T){
 const keys=new Set(group.lines.flatMap(l=>l.glyphs.map(g=>address(g.glyph))));
 const shared=batches.filter(b=>[...keys].some(k=>b.keys.has(k)));
 const batch=shared[0]??{keys:new Set<string>(),members:[]};
 if(!shared.length)batches.push(batch);
 for(const key of keys)batch.keys.add(key);
 for(const other of shared.slice(1)){
  for(const key of other.keys)batch.keys.add(key);
  batch.members.push(...other.members);batches.splice(batches.indexOf(other),1);
 }
 batch.members.push(member);
}
