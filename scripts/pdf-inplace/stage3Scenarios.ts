// Acceptance inputs declared before extending the native oracle. All edits
// address decoded bytes inside one string; expected text is independent.
export const stage3Scenarios = [
  {name:'span-middle', source:'(Hello World) Tj', old:'Hello World', start:6,end:11,replacement:'Text', expected:'Hello Text'},
  {name:'span-tj-kerns', source:'[(Hello World) 120 ( tail)] TJ', old:'Hello World', start:6,end:11,replacement:'Text',expected:'Hello Text'},
  {name:'span-tracked',source:'2 Tc 4 Tw 80 Tz 3 Ts 40 TL (Hello World today) Tj ( tail) Tj T* (next) Tj',old:'Hello World today',start:6,end:11,replacement:'Text',expected:'Hello Text today'},
  {name:'span-mcid',source:'/P <</MCID 0>> BDC (Hello World) Tj EMC ( tail) Tj',old:'Hello World',start:6,end:11,replacement:'Text',expected:'Hello Text'},
  {name:'span-shorter',source:'(Hello World) Tj ( tail) Tj',old:'Hello World',start:6,end:11,replacement:'Hi',expected:'Hello Hi'},
  {name:'span-longer',source:'[(Hello World) -5000 ( tail)] TJ',old:'Hello World',start:6,end:11,replacement:'Hello Again',expected:'Hello Hello Again',allowOverflow:true},
  {name:'fallback-accent',source:'(Hello World) Tj ( tail) Tj',old:'Hello World',start:6,end:11,replacement:'café',expected:'Hello café',fallback:true},
  {name:'fallback-cjk',source:'(Hello World) Tj ( tail) Tj',old:'Hello World',start:6,end:11,replacement:'漢',expected:'Hello 漢',fallback:true},
  {name:'fallback-dash-tracked',source:'2 Tc 4 Tw 80 Tz (Hello World) Tj ( tail) Tj 0 -40 Td (next) Tj',old:'Hello World',start:6,end:11,replacement:'A—B',expected:'Hello A—B',fallback:true},
  {name:'refuse-overflow',source:'(Hello World) Tj ( tail) Tj',old:'Hello World',start:6,end:11,replacement:'Hello Again',reason:'replacement overflows available space'},
  {name:'refuse-cross-item',source:'[(Hello) 120 (World)] TJ',old:'Hello',start:3,end:8,replacement:'X',reason:'span'},
  {name:'refuse-quote-span',source:"(Hello World) '",old:'Hello World',start:6,end:11,replacement:'X',reason:'show operator'},
  {name:'refuse-fstype',source:'(Hello World) Tj',old:'Hello World',start:6,end:11,replacement:'é',fallback:true,restricted:true,reason:'embedding'},
] as const;
