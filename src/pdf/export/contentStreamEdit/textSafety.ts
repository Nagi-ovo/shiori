import type {ContentOp} from './tokenizer';
export type RunEnvironment={
 markedContentProperties?:ReadonlyMap<string,readonly string[]|null>;
 markedContentMcids?:ReadonlyMap<string,number>;
 extGStates?:ReadonlyMap<string,{setsFont:boolean;safe:boolean}>;
};
export function textObjectScopes(ops:readonly ContentOp[]):Map<number,number>{
 const scopes=new Map<number,number>();let current=-1;
 ops.forEach((op,i)=>{if(op.operator==='BT')current=i;if(current>=0)scopes.set(i,current);if(op.operator==='ET')current=-1;});return scopes;
}
export function followsUnplaced(scopes:ReadonlyMap<number,number>,unplaced:readonly number[],target:number){return unplaced.some(i=>i<=target && scopes.get(i)===scopes.get(target));}
