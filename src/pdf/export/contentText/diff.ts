export type TextChange = { start: number; end: number; replacement: string };
function trimmed(a: string, b: string, offset: number): TextChange[] {
  const aa = Array.from(a), bb = Array.from(b);
  let prefix = 0, suffix = 0;
  while (prefix < aa.length && prefix < bb.length && aa[prefix] === bb[prefix]) prefix++;
  while (suffix < aa.length-prefix && suffix < bb.length-prefix && aa[aa.length-1-suffix] === bb[bb.length-1-suffix]) suffix++;
  const start = aa.slice(0,prefix).join('').length;
  const end = a.length-aa.slice(aa.length-suffix).join('').length;
  const replacement = bb.slice(prefix,bb.length-suffix).join('');
  return start === end && !replacement ? [] : [{ start:offset+start,end:offset+end,replacement }];
}
/** Match unchanged words first, then tighten each changed gap to scalar boundaries. */
export function lineChanges(a: string, b: string): TextChange[] {
  const aa = a.match(/\s+|[^\s]+/gu) ?? [], bb = b.match(/\s+|[^\s]+/gu) ?? [];
  if (aa.length*bb.length > 250000) return trimmed(a,b,0);
  const grid = Array.from({length:aa.length+1},()=>new Uint32Array(bb.length+1));
  for(let i=aa.length-1;i>=0;i--) for(let j=bb.length-1;j>=0;j--)
    grid[i]![j] = aa[i] === bb[j] ? 1+grid[i+1]![j+1]! : Math.max(grid[i+1]![j]!,grid[i]![j+1]!);
  const result: TextChange[] = [];
  let i=0,j=0,offset=0,old='',next='';
  const flush=()=>{result.push(...trimmed(old,next,offset-old.length));old='';next='';};
  while(i<aa.length || j<bb.length) {
    if(i<aa.length && j<bb.length && aa[i]===bb[j]) {flush();offset+=aa[i]!.length;i++;j++;}
    else if(j<bb.length && (i===aa.length || grid[i]![j+1]! >= grid[i+1]![j]!)) next+=bb[j++]!;
    else {const token=aa[i++]!;old+=token;offset+=token.length;}
  }
  flush();return result;
}
