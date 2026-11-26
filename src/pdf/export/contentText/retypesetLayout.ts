import type {planRetypeset} from './retypesetPlan';
import type {RetypesetCluster,RetypesetAdjustment} from './retypesetTypes';

/** Measurement and emission share this state; the source home stays intact. */
export function retypesetClusterState(a:RetypesetCluster){
 const s=a.size&&a.size!==1?{...a.home.state,fontSize:a.home.state.fontSize*a.size}:a.home.state,f=a.fit;
 return f?{...s,fontSize:s.fontSize*f.sizeScale,charSpacing:s.charSpacing-s.fontSize*f.trackingEm,
  wordSpacing:s.wordSpacing-s.fontSize*f.wordReductionEm}:s;
}

/** Only explicitly owned blocks reflow, including an accepted paragraph tail.
 * Every other source line retains its original operators and coordinates. */
export function layoutRetypeset(plan:ReturnType<typeof planRetypeset>,adjustment?:RetypesetAdjustment,measure?:{left:number;right:number},options:{keepTrailingSpaces?:boolean}={}){
 const {group}=plan,size=plan.tail[0]!.state.fontSize;
 let lines=plan.unchangedLines.length,bottom=Infinity,top=-Infinity,maxRight=-Infinity,addedHeight=0;
 const advance=(a:RetypesetCluster)=>{
  const f=a.font!,s=retypesetClusterState(a),code=f.bytesPerCode===1?a.bytes![0]!:a.bytes![0]!*256+a.bytes![1]!;
  return (f.widthOf(code)*s.fontSize/1000+s.charSpacing+(f.bytesPerCode===1&&code===32?s.wordSpacing:0))*(s.horizontalScale??1);
 };
 // Validate before mutating any cluster: an invalid spacing candidate must
 // leave the preceding successful measurement and positions intact.
 const advances=plan.output.filter(a=>!a.hard).map(a=>({a,value:advance({...a,fit:adjustment})}));
 if(advances.some(a=>!Number.isFinite(a.value)||a.value<0))throw Error('unmeasurable output advance');
 for(const {a,value}of advances){a.fit=adjustment;a.advance=value;}
 for(const block of plan.blocks){
  const output=block.output,original=group.lines[block.firstLine]!,requested=output.reduce((n,a)=>Math.max(n,a.size??1),1);
  let x=original.x,y=original.y,rows=1;
  // A one-line group witnesses no measure beyond its own ink: a size request
  // grows that line with the text. Known paragraph measures rewrap instead.
  const left=measure?.left??group.lines[1]?.x??group.left,own=group.lines.length===1&&!measure&&requested>1;
  const right=own?original.x+(Math.max(group.right,left+size)-original.x)*requested:measure?.right??Math.max(group.right,left+size),width=right-left;
  const newline=()=>{x=left;y-=group.pitch*requested*(adjustment?.leadingScale??adjustment?.sizeScale??1);rows++;};
  for(let i=0;i<output.length;){
   if(output[i]!.hard){newline();i++;continue;}
   let end=i+1;
   if(!/\s|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(output[i]!.text))while(end<output.length&&!output[end]!.hard&&!/\s|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(output[end]!.text))end++;
   const needed=output.slice(i,end).reduce((n,a)=>n+a.advance!,0);
   const trailingSpace=options.keepTrailingSpaces&&/^\s+$/u.test(output[i]!.text);
   if(!trailingSpace&&x>left+.01&&x+needed>right+.01&&needed<=width)newline();
   for(;i<end;i++){
    const a=output[i]!;
    // Source whitespace stays source whitespace. A join is only internal to
    // a changed block; it can never indent an untouched line.
    if(x>left+.01&&x+a.advance!>right+.01&&!/^\s+$/u.test(a.text))newline();
    // An owned paragraph tail keeps break spaces on the preceding row. They
    // retain their source codes/advances without indenting the next word or
    // counting invisible trailing whitespace as a wider painted measure.
    a.x=x;a.y=y;x+=a.advance!;if(!trailingSpace)maxRight=Math.max(maxRight,x);
   }
  }
  lines+=rows;bottom=Math.min(bottom,y-size*requested*.25);top=Math.max(top,original.y+size*requested);
  addedHeight=Math.max(addedHeight,Math.max(0,group.lines[block.lastLine]!.y-y));
 }
 return {lines,bottom,top,maxRight,addedHeight};
}
