import type {FontInput} from './types';
import {type1Container} from './type1Container';
import {decryptType1} from './type1Cipher';
import {type1Dictionary} from './type1Dictionary';
import {type1CharStrings} from './type1CharString';
import {rejectType1,type1Hash} from './type1Support';
export function readType1Program(input:FontInput) {
  if(input.subtype==='MMType1')rejectType1('type1-ps-unsupported','MMType1 interpolation');
  const container=type1Container(input),privateBytes=decryptType1(container.encrypted,55665,4);
  const dict=type1Dictionary(container.clear,privateBytes);
  return {kind:'type1' as const,...dict,...type1CharStrings(dict),programHash:type1Hash(input.program!),clearHash:type1Hash(container.clear),privateHash:type1Hash(privateBytes)};
}
export type Type1Program=ReturnType<typeof readType1Program>;
