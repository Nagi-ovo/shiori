import {PDFArray,PDFDict,PDFName,PDFNumber,PDFRawStream,type PDFPage} from 'pdf-lib';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import type {Rect} from './regionProof';
import {contains,intersects} from './regionProof/geometry';
import type {OccupantKind} from './regionProof/occupancy';
type Matrix=number[];
const identity=()=>[1,0,0,1,0,0];
const multiply=(a:Matrix,b:Matrix)=>[a[0]!*b[0]!+a[2]!*b[1]!,a[1]!*b[0]!+a[3]!*b[1]!,a[0]!*b[2]!+a[2]!*b[3]!,a[1]!*b[2]!+a[3]!*b[3]!,a[0]!*b[4]!+a[2]!*b[5]!+a[4]!,a[1]!*b[4]!+a[3]!*b[5]!+a[5]!];
export const numericArray=(d:PDFDict,k:string)=>d.lookupMaybe(PDFName.of(k),PDFArray)?.asArray().map(v=>d.context.lookup(v)).map(v=>v instanceof PDFNumber?v.asNumber():NaN);
const union=(a:Rect,b:Rect):Rect=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.max(a.x+a.w,b.x+b.w)-Math.min(a.x,b.x),h:Math.max(a.y+a.h,b.y+b.h)-Math.min(a.y,b.y)});
const intersection=(a:Rect,b:Rect):Rect=>({x:Math.max(a.x,b.x),y:Math.max(a.y,b.y),w:Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)),h:Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y))});
const expand=(b:Rect,n:number):Rect=>({x:b.x-n,y:b.y-n,w:b.w+2*n,h:b.h+2*n});
const fromPoints=(p:number[][]):Rect=>{const xs=p.map(p=>p[0]!),ys=p.map(p=>p[1]!);return {x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};};
const transform=(m:Matrix,x:number,y:number)=>[m[0]!*x+m[2]!*y+m[4]!,m[1]!*x+m[3]!*y+m[5]!];
const transformedBox=(m:Matrix,b:number[])=>fromPoints([[b[0]!,b[1]!],[b[2]!,b[1]!],[b[2]!,b[3]!],[b[0]!,b[3]!]].map(([x,y])=>transform(m,x!,y!)));
/** Bounds are obstacles, never evidence of empty paint. Forms are bounded by
 * their mandatory BBox/Matrix without recursing into their opaque contents.
 * Unknown paint uses the current clip (the page when no local clip is known).
 */
export function reflowScene(page:PDFPage,ops:readonly ContentOp[],media:Rect,record?:(box:Rect,kind:OccupantKind,op:number)=>void,guardPt=.5):Rect[]{
 const obstacles:Rect[]=[],resources=page.node.Resources(),xobjects=resources?.lookupMaybe(PDFName.of('XObject'),PDFDict);
 let state={ctm:identity(),ctmKnown:true,clip:media,clipFull:true,width:1,miter:10,strokeUnknown:false,
  fillPlain:true,blendNormal:true,noSoftMask:true},path:Rect|undefined,clipPending=false,singleRect=false;
 const stack:typeof state[]=[];
 const r=page.getCropBox(),crop={x:r.x,y:r.y,w:r.width,h:r.height};
 // This deliberately stronger z proof precedes EVERY source show. The
 // compiler only writes destinations into existing shows, so it also proves
 // the backdrop is below every owned op and every destination glyph.
 const firstShow=ops.findIndex(op=>['Tj','TJ',"'",'"'].includes(op.operator));
 let paintOp=-1;
 const add=(box:Rect,kind:OccupantKind='paint')=>{const b=intersection(expand(box,guardPt),state.clip);if(b.w>0&&b.h>0){obstacles.push(b);record?.(b,kind,paintOp);}};
 const clear=()=>{if(clipPending)state={...state,clip:intersection(state.clip,path??state.clip),clipFull:false};path=undefined;clipPending=false;singleRect=false;};
 const inert=new Set(['BT','ET','Tf','Tm','Td','TD','T*','Tc','Tw','Tz','TL','Ts','Tr','Tj','TJ',"'",'"','rg','RG','g','G','k','K','cs','CS','sc','SC','scn','SCN','J','j','d','ri','i','BMC','BDC','EMC','MP','DP','BX','EX']);
 for(const op of ops){
  paintOp++;
  const n=op.operands.map(v=>v.kind==='number'?v.value:NaN);
  switch(op.operator){
   case 'q':stack.push({...state,ctm:[...state.ctm]});break;
   case 'Q':state=stack.pop()??{...state,ctm:identity(),ctmKnown:false,clip:media,clipFull:false,strokeUnknown:true,fillPlain:false,blendNormal:false,noSoftMask:false};break;
   case 'cm':if(n.length===6&&n.every(Number.isFinite)){
    const ctm=multiply(state.ctm,n);state={...state,ctm,ctmKnown:state.ctmKnown&&ctm.every(Number.isFinite)};
   }else{state={...state,ctmKnown:false};add(state.clip);}break;
   case 'g':case 'rg':case 'k':state={...state,fillPlain:n.length===({g:1,rg:3,k:4}[op.operator])&&n.every(Number.isFinite)};break;
   case 'cs':{
    const name=op.operands[0];state={...state,fillPlain:op.operands.length===1&&name?.kind==='name'&&['DeviceGray','DeviceRGB','DeviceCMYK'].includes(name.value)};break;
   }
   case 'sc':case 'scn':state={...state,fillPlain:state.fillPlain&&n.length>0&&n.every(Number.isFinite)};break;
   case 'w':if(n.length!==1||!Number.isFinite(n[0])||n[0]!<0)state={...state,strokeUnknown:true};else state={...state,width:n[0]!};break;
   case 'M':if(n.length!==1||!Number.isFinite(n[0])||n[0]!<1)state={...state,strokeUnknown:true};else state={...state,miter:n[0]!};break;
   case 'gs':{
    const name=op.operands[0],states=resources?.lookupMaybe(PDFName.of('ExtGState'),PDFDict),d=op.operands.length===1&&name?.kind==='name'?states?.lookupMaybe(PDFName.of(name.value),PDFDict):undefined;
    if(!d){state={...state,strokeUnknown:true,blendNormal:false,noSoftMask:false};break;}
    for(const [key,field,value]of [['BM','blendNormal','Normal'],['SMask','noSoftMask','None']]as const){
     if(d.has(PDFName.of(key))){const v=d.lookup(PDFName.of(key));state={...state,[field]:v instanceof PDFName&&v.decodeText()===value};}
    }
    for(const [key,field]of [['LW','width'],['ML','miter']]as const){
     const v=d.lookup(PDFName.of(key));if(v===undefined)continue;
     if(!(v instanceof PDFNumber)||!Number.isFinite(v.asNumber())||v.asNumber()<(field==='miter'?1:0))state={...state,strokeUnknown:true};
     else state={...state,[field]:v.asNumber()};
    }
    break;
   }
   case 'm':case 'l':case 'c':case 'v':case 'y':case 're':{
    const count={m:2,l:2,c:6,v:4,y:4,re:4}[op.operator];
    if(n.length!==count||!n.every(Number.isFinite)||!state.ctmKnown){path=state.clip;singleRect=false;break;}
    singleRect=op.operator==='re'&&!path&&Math.abs(state.ctm[1]!)<=1e-9&&Math.abs(state.ctm[2]!)<=1e-9&&state.ctm[0]!==0&&state.ctm[3]!==0;
    const b=op.operator==='re'?transformedBox(state.ctm,[n[0]!,n[1]!,n[0]!+n[2]!,n[1]!+n[3]!]):fromPoints(Array.from({length:n.length/2},(_,i)=>transform(state.ctm,n[2*i]!,n[2*i+1]!)));
    path=path?union(path,b):b;break;
   }
   case 'h':break;
   case 'W':case 'W*':clipPending=true;break;
   case 'n':clear();break;
   case 'S':case 's':case 'B':case 'B*':case 'b':case 'b*':{
    // A Frobenius norm bounds scaling under any affine transform; miter
    // joins and square caps remain inside this deliberately broad envelope.
    const scale=Math.hypot(...state.ctm.slice(0,4));
    add(state.strokeUnknown?state.clip:expand(path??state.clip,Math.max(.5,state.width*scale*state.miter)));clear();break;
   }
   case 'f':case 'F':case 'f*':{
    // A bbox around an arbitrary path is never enough. Active/pending clips
    // are also excluded: their bbox does not prove the rectangle was painted.
    if(!op.operands.length&&path&&singleRect&&state.ctmKnown&&state.clipFull&&!clipPending&&state.fillPlain&&state.blendNormal&&state.noSoftMask&&
     paintOp<firstShow&&contains(path,media)&&contains(path,crop))record?.(media,'backdrop',paintOp);
    else add(path??state.clip);
    clear();break;
   }
   case 'Do':{
    const name=op.operands[0];
    const raw=name?.kind==='name'?xobjects?.lookup(PDFName.of(name.value)):undefined;
    const d=raw instanceof PDFRawStream?raw.dict:undefined,subtype=d?.lookupMaybe(PDFName.of('Subtype'),PDFName)?.decodeText();
    if(subtype==='Image')add(transformedBox(state.ctm,[0,0,1,1]),'image');
    else if(subtype==='Form'&&d){const b=numericArray(d,'BBox'),m=numericArray(d,'Matrix')??identity();
     if(b?.length===4&&m.length===6&&[...b,...m].every(Number.isFinite))add(transformedBox(multiply(state.ctm,m),b),'form');else add(state.clip,'unknown');
    }else add(state.clip,'unknown');
    break;
   }
   case 'BI':add(transformedBox(state.ctm,[0,0,1,1]),'image');break;
   default:if(!inert.has(op.operator))add(state.clip,'unknown');
  }
 }
 const annotations=page.node.Annots();
 for(let i=0;i<(annotations?.size()??0);i++){
  const d=annotations!.lookup(i),a=d instanceof PDFDict?numericArray(d,'Rect'):undefined;
  const box=a?.length===4&&a.every(Number.isFinite)?expand({x:Math.min(a[0]!,a[2]!),y:Math.min(a[1]!,a[3]!),w:Math.abs(a[2]!-a[0]!),h:Math.abs(a[3]!-a[1]!)},guardPt):media;
  obstacles.push(box);record?.(box,'annot',ops.length+i);
 }
 return obstacles.filter(b=>intersects(b,media));
}
