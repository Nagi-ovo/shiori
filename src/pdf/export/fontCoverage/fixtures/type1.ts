// Original tiny Type1 generators. No font data is copied from installed fonts.
export const ascii = (s:string) => Uint8Array.from(s,c=>c.charCodeAt(0));
export function join(...parts:Uint8Array[]):Uint8Array {
  const out=new Uint8Array(parts.reduce((n,b)=>n+b.length,0));let p=0;
  for(const b of parts){out.set(b,p);p+=b.length;}return out;
}
// Independent encryption (the production module only decrypts).
export function encrypt(data:Uint8Array,seed:number):Uint8Array {
  let state=seed;return data.map(b=>{const c=b^(state>>>8);state=((c+state)*52845+22719)&65535;return c;});
}
export function nums(...values:number[]):number[] {
  return values.flatMap(n=> n>=-107 && n<=107?[n+139]:n>=108 && n<=1131?[247+((n-108)>>8),(n-108)&255]:n<=-108 && n>=-1131?[251+((-n-108)>>8),(-n-108)&255]:[255,(n>>24)&255,(n>>16)&255,(n>>8)&255,n&255]);
}
export const widthChar=(width=600)=>Uint8Array.from([...nums(0,width),13,14]);
export type TinyType1Options={lenIV?:number;glyphs?:Record<string,Uint8Array>;subrs?:Uint8Array[];clear?:string;private?:string;hex?:boolean;encoding?:string;eexecPrefix?:Uint8Array};
export function tinyType1(o:TinyType1Options={}) {
  const lenIV=o.lenIV??4;
  const char=(bytes:Uint8Array)=>lenIV===-1?bytes:encrypt(join(new Uint8Array(lenIV),bytes),4330);
  const glyphs=o.glyphs??{'.notdef':widthChar(0),A:widthChar(),B:widthChar(),f_i:widthChar()};
  const clear=ascii(`%!PS-AdobeFont-1.0: Tiny 1.0\n11 dict begin\n/FontName /Tiny def\n/FontType 1 def\n/FontMatrix [0.001 0 0 0.001 0 0] readonly def\n/FontBBox [0 0 600 700] readonly def\n/Encoding ${o.encoding??'StandardEncoding'} def\n${o.clear??''}\ncurrentdict end\ncurrentfile eexec\n`);
  const privateBytes=join(ascii(`dup /Private 8 dict dup begin\n/RD {string currentfile exch readstring pop} executeonly def\n/ND {noaccess def} executeonly def\n/NP {noaccess put} executeonly def\n/lenIV ${lenIV} def\n${o.private??''}\n/Subrs ${(o.subrs??[]).length} array\n`),
    ...((o.subrs??[]).map((b,i)=>{const data=char(b);return join(ascii(`dup ${i} ${data.length} RD `),data,ascii(' NP\n'));})),
    ascii(`readonly def\n2 index /CharStrings ${Object.keys(glyphs).length} dict dup begin\n`),
    ...Object.entries(glyphs).map(([name,b])=>{const data=char(b);return join(ascii(`/${name} ${data.length} RD `),data,ascii(' ND\n'));}),
    ascii('end end readonly put noaccess put\ndup /FontName get exch definefont pop\nmark currentfile closefile\n'));
  const binary=encrypt(join(o.eexecPrefix??Uint8Array.of(12,34,56,78),privateBytes),55665);
  const encrypted=o.hex?ascii(Array.from(binary,b=>b.toString(16).padStart(2,'0')).join('')):binary;
  const trailer=ascii('\n'+'0'.repeat(512)+'\ncleartomark\n');
  return {program:join(clear,encrypted,trailer),clear,encrypted,binary,trailer,length1:clear.length,length2:encrypted.length,length3:trailer.length};
}
export function pfb(...records:[number,Uint8Array][]) {
  return join(...records.map(([type,data])=>{const h=new Uint8Array(6);h.set([128,type]);new DataView(h.buffer).setUint32(2,data.length,true);return join(h,data);}),Uint8Array.of(128,3));
}

// Canonical Adobe 0/1/2/3 helper Subrs and an independently specified shallow
// double curve: start (100,-10), reference (150,-10), end (200,-10).
export const flexSubrs=[
  Uint8Array.from([...nums(3,0),12,16,12,17,12,17,12,33,11]),
  Uint8Array.from([...nums(0,1),12,16,11]),
  Uint8Array.from([...nums(0,2),12,16,11]),
  Uint8Array.of(11),
  Uint8Array.from([...nums(0,20),1,11]),
];
export const flexVectors=[[50,0],[-35,0],[10,10],[25,0],[25,0],[10,-10],[15,0]] as const;
export function flexChar(options:{vectors?:readonly (readonly number[])[];end?:readonly number[];finish?:number[]}={}) {
  return Uint8Array.from([...nums(0,600),13,...nums(100,-10),21,...nums(1),10,
    ...(options.vectors??flexVectors).flatMap(v=>[...nums(...v),21,...nums(2),10]),
    ...nums(...(options.end??[50,200,-10])),...(options.finish??[...nums(0),10]),14]);
}
export const hintChar=Uint8Array.from([...nums(0,600),13,...nums(4,1,3),12,16,12,17,10,14]);
export const seacChar=Uint8Array.from([...nums(0,600),13,...nums(0,0,0,65,194),12,6]);
