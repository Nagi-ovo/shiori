type Point={x:number;y:number};
type Identity={fontName:string;code:number};
type Glyph=Identity&{quad:readonly Point[];coreQuad:readonly Point[]};
type Destination=Identity&{point:Point};

// PDF serialization and matrix arithmetic may straddle a 1e-5 rounding bin.
// Compare coordinates directly: 0.0001 pt is far below a visible displacement.
const tolerance=1e-4;
const near=(a:Point,b:Point)=>Math.abs(a.x-b.x)<=tolerance&&Math.abs(a.y-b.y)<=tolerance;

/** Exact font/code identities with tolerant coordinates, consumed once. No
 * rounded-position identity or transitive merging of neighbouring glyphs. */
export function verifyRetypesetGlyphs(actual:readonly Glyph[],untargeted:readonly Glyph[],output:readonly Destination[]){
 const byIdentity=new Map<string,Set<Glyph>>();
 const key=(g:Identity)=>JSON.stringify([g.fontName,g.code]);
 for(const g of actual){const k=key(g),set=byIdentity.get(k)??new Set<Glyph>();set.add(g);byIdentity.set(k,set);}
 const consume=(g:Identity,matches:(candidate:Glyph)=>boolean,message:string)=>{
  const candidates=byIdentity.get(key(g)),found=candidates&&[...candidates].find(matches);
  if(!found)throw Error(message);
  candidates!.delete(found);
 };
 for(const g of untargeted)consume(g,c=>c.quad.length===g.quad.length&&c.quad.every((p,i)=>near(p,g.quad[i]!))&&near(c.coreQuad[0]!,g.coreQuad[0]!),
  'untargeted glyph changed font, codes or position');
 for(const g of output)consume(g,c=>near(c.coreQuad[0]!,g.point),'output glyph font, codes or destination differs');
 if(actual.length!==untargeted.length+output.length)throw Error('compiled glyph count differs');
}
