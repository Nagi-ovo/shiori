import type { Type1Diagnostic, Type1Reason } from './type1Support';
/** Parsed PDF dictionaries and decoded program bytes; no pdf-lib dependency. */
export type FontInput = {
  subtype: string;
  baseFont?: string;
  flags?: number;
  fontMatrix?: readonly number[];
  fontBBox?: readonly number[];
  firstChar?: number;
  lastChar?: number;
  widths?: readonly number[];
  length1?: number;
  length2?: number;
  length3?: number;
  encoding?: string | { base?: string; differences?: Record<number, string>; cmap?: string };
  toUnicode?: string;
  program?: Uint8Array;
  programKind?: string;
  cidSubtype?: string;
  cidToGid?: 'Identity' | Uint8Array;
  charProcs?: string[];
  /** Adapter errors refuse coverage rather than guessing a missing dictionary. */
  error?: string;
  diagnostic?: Type1Diagnostic;
};
export type GlyphIdentity =
  | {kind:'gid';programHash:string;gid:number}
  | {kind:'type1-name';programHash:string;name:string}
  | {kind:'type3-name';fontHash:string;procHash:string;name:string}
  | {kind:'standard14';face:string;name:string};
export type FontResolution={fontObject:string;resourceScopeHash:string;dependencyHash:string;mappings:ReadonlyMap<string,VerifiedCode>;failures:readonly Type1Diagnostic[]};
export type VerifiedCode={bytes:Uint8Array;unicode:string;glyph:GlyphIdentity;width1000:number;
  widthSource:'pdf-widths'|'cid-widths'|'standard-afm'|'type3-widths';unicodeSource:'to-unicode'|'verified-glyph-name';
  ink?: {box:{x:number;y:number;w:number;h:number};proofHash:string};
  replacementProof?:{toUnicodeLabel:string;verifiedGlyphName:string;glyphNameUnicode:string}};
export type MissingMapping = { code?: string; cluster?: string; reason: string };
export type EncodeOptions = { preferredCodes?: readonly Uint8Array[] };
export type EncodeResult =
  | { ok: true; codes: Uint8Array[]; bytes: Uint8Array; preferredApplied: boolean }
  | { ok: false; reason: string; firstMissing: string; offset: number; code?: Type1Reason; detail?: string; terminal?: boolean; data?: Type1Diagnostic['data'] };
export type FontCoverage = {
  subtype: string;
  mappings?: Map<string,VerifiedCode>;
  failures?: (Type1Diagnostic & {hex?:string;cluster?:string})[];
  replacementDisabled?: string;
  baseFont: string;
  subsetTag: string | null;
  encodingKind: string;
  vertical: boolean;
  verification: 'verified' | 'assumed-standard' | 'defined-type3' | 'unverified';
  warnings: string[];
  missing: MissingMapping[];
  /** Hex code → text, including mappings rejected by program verification. */
  codeToUnicode: Map<string, string>;
  encodable: Map<string, Uint8Array[]>;
  /** Actual program GID selected for a code (including rejected GID 0).
   * Standard-14/Type3 have no embedded program GIDs. */
  glyphIds: Map<string, number>;
  definedCodes: Uint8Array[];
  canEncode(text: string, options?: EncodeOptions): EncodeResult;
};
export const codeHex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
export const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], s => parseInt(s,16));
export const codeNumber = (hex: string): number => parseInt(hex,16);
