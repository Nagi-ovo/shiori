import type {FontInput} from './types';
import {type1Container} from './type1Container';
import {decryptType1} from './type1Cipher';
import {type1Dictionary} from './type1Dictionary';
import {type1CharStrings} from './type1CharString';
import {Type1Error,rejectType1,type1Hash} from './type1Support';
export function readType1Program(input:FontInput) {
  if(input.subtype==='MMType1')rejectType1('type1-ps-unsupported','MMType1 interpolation');
  const container=type1Container(input);
  const parse=(cipher:Uint8Array)=>{const privateBytes=decryptType1(cipher,55665,4);return {privateBytes,dict:type1Dictionary(container.clear,privateBytes)};};
  let parsed:ReturnType<typeof parse>;
  try{parsed=parse(container.encrypted);}catch(error){
    if(!(error instanceof Type1Error)||error.diagnostic.code==='parser-budget-exceeded'||!container.binaryRetry)throw error;
    try{parsed=parse(container.binaryRetry);}catch(binaryError){
      if(!(binaryError instanceof Type1Error)||binaryError.diagnostic.code==='parser-budget-exceeded')throw binaryError;
      throw error;
    }
  }
  const {dict,privateBytes}=parsed;
  return {kind:'type1' as const,...dict,...type1CharStrings(dict),programHash:type1Hash(input.program!),clearHash:type1Hash(container.clear),privateHash:type1Hash(privateBytes)};
}
export type Type1Program=ReturnType<typeof readType1Program>;
