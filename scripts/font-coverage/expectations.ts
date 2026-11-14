/** Fixture outcomes are specified independently of the resolver. Changing a
 * fixture requires reviewing these literal code/GID expectations as well. */
export type ExpectedRow = {
  code:string;
  status:'round-trip'|'rejected';
  gid?:number;
  reasonContains?:string;
  font?:string;
  page?:number;
  path?:string[];
};
const verified=(code:string,gid?:number,font='F1'):ExpectedRow=>({code,status:'round-trip',gid,font});
const rejected=(code:string,reasonContains:string,gid?:number):ExpectedRow=>({code,status:'rejected',reasonContains,gid});
const subset=[verified('53',1),verified('61',2),verified('6e',3),rejected('64','.notdef',0)];
const standard=['53','61','6e','64'].map(code=>verified(code));
const rows:Record<string,ExpectedRow[]>={
  subset,
  'distinct-subsets':[...subset,verified('53',7,'F2')],
  'cid-map':[rejected('0001','.notdef',0),verified('002a',7)],
  'cid-default':[verified('0001',1),rejected('002a','GID outside font program',42)],
  'embedded-cmap':[verified('41',7)],
  'cid-cff':[rejected('0001','.notdef',0),verified('002a',1)],
  'simple-cff':[verified('41',1)],
  standard14:standard,
  type3:[verified('53')],
  truncated:standard.map(row=>rejected(row.code,'font program')),
  format4:[verified('41',1),verified('42',2),verified('53',7),rejected('54','.notdef',0),verified('55',3)],
  format12:[verified('41',1),verified('42',2),verified('43',3),verified('53',7),rejected('54','.notdef',0)],
  'standard14-notdef':[rejected('00','glyph not in standard font')],
  'cff-supplement':[rejected('41','unsupported CFF encoding supplements')],
  'symbolic-duplicate':[verified('41',7),verified('53',1)],
  'symbolic-ambiguous':[rejected('41','ambiguous symbolic TrueType cmap'),verified('53',1)],
  'both-flags':[verified('53',1)],
};
export function expectedRows(name:string):readonly ExpectedRow[] {
  const expected=rows[name];
  if(!expected)throw new Error(`missing expected rows for generated fixture ${name}`);
  return expected;
}
