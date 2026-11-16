import type {planRetypeset} from './retypesetPlan';
import type {RetypesetCluster} from './retypesetTypes';

/** Changed blocks alone reflow. Untouched source lines never enter layout. */
export function layoutRetypeset(plan:ReturnType<typeof planRetypeset>,limits?:{left:number;right:number}){
 const {group}=plan,size=plan.tail[0]!.state.fontSize;
 let lines=plan.unchangedLines.length,bottom=Infinity,top=-Infinity,maxRight=-Infinity,addedHeight=0;
 const advance=(a:RetypesetCluster)=>{
  const f=a.font!,s=a.home.state,code=f.bytesPerCode===1?a.bytes![0]!:a.bytes![0]!*256+a.bytes![1]!;
  return (f.widthOf(code)*s.fontSize/1000+s.charSpacing+(f.bytesPerCode===1&&code===32?s.wordSpacing:0))*(s.horizontalScale??1);
 };
 for(const block of plan.blocks){
  const output=block.output,original=group.lines[block.firstLine]!;
  let x=original.x,y=original.y,rows=1;
  const left=limits?.left??group.lines[1]?.x??group.left,right=limits?.right??Math.max(group.right,left+size),width=right-left;
  for(const a of output)if(!a.hard){a.advance=advance(a);if(!Number.isFinite(a.advance)||a.advance<0)throw Error('unmeasurable output advance');}
  const newline=()=>{x=left;y-=group.pitch;rows++;};
  for(let i=0;i<output.length;){
   if(output[i]!.hard){newline();i++;continue;}
   let end=i+1;
   if(!/\s|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(output[i]!.text))while(end<output.length&&!output[end]!.hard&&!/\s|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(output[end]!.text))end++;
   const needed=output.slice(i,end).reduce((n,a)=>n+a.advance!,0);
   if(x>left+.01&&x+needed>right+.01&&needed<=width)newline();
   for(;i<end;i++){
    const a=output[i]!;
    // Source whitespace stays source whitespace. A join is only internal to
    // a changed block; it can never indent an untouched line.
    if(x>left+.01&&x+a.advance!>right+.01&&!/^\s+$/u.test(a.text))newline();
    a.x=x;a.y=y;x+=a.advance!;maxRight=Math.max(maxRight,x);
   }
  }
  lines+=rows;bottom=Math.min(bottom,y-size*.25);top=Math.max(top,original.y+size);
  addedHeight=Math.max(addedHeight,Math.max(0,group.lines[block.lastLine]!.y-y));
 }
 return {lines,bottom,top,maxRight,addedHeight};
}
