/** Original CID CFF: GID1 is a 100x100 triangle, GID2 a 200x100 triangle.
 * One FD; fixed-width DICT integers keep absolute offsets stable. */
export function cidCff({matrix=[],brokenGlyph=false,missingGlyph=false,charset=[1,2]}:{matrix?:number[];brokenGlyph?:boolean;missingGlyph?:boolean;charset?:[number,number]}={}){
 const idx=(items:number[][])=>{let n=1;return[0,items.length,1,...items.map(i=>{const v=n;n+=i.length;return v;}),n,...items.flat()];};
 const integer=(n:number)=>[29,n>>>24&255,n>>>16&255,n>>>8&255,n&255];
 const chars=idx([[14],missingGlyph?[]:[139,139,21,239,139,5,139,239,5,39,39,5,brokenGlyph?15:14],[139,139,21,247,92,139,5,139,239,5,251,92,39,5,14]]),name=idx([[84,105,110,121]]);
 const dict=(charset:number,charStrings:number,fdSelect:number,fdArray:number)=>[139,139,139,12,30,...integer(charset),15,...integer(charStrings),17,...integer(fdSelect),12,37,...integer(fdArray),12,36];
 const start=4+name.length+idx([dict(0,0,0,0)]).length+4;
 const fd=(privateOffset:number)=>[...(matrix.length?[...matrix.flatMap(integer),12,7]:[]),139,...integer(privateOffset),18];
 const fdArray=start+5+chars.length+4,privateOffset=fdArray+idx([fd(0)]).length;
 return Uint8Array.from([1,0,4,4,...name,...idx([dict(start,start+5,start+5+chars.length,fdArray)]),0,0,0,0,
  0,...charset.flatMap(n=>[n>>>8,n&255]),...chars,0,0,0,0,...idx([fd(privateOffset)])]);
}
