/** Parsed PDF dictionaries and decoded program bytes; no pdf-lib dependency. */
export type FontInput = {
  subtype: string;
  baseFont?: string;
  flags?: number;
  encoding?: string | { base?: string; differences?: Record<number, string>; cmap?: string };
  toUnicode?: string;
  program?: Uint8Array;
  programKind?: string;
  cidSubtype?: string;
  cidToGid?: 'Identity' | Uint8Array;
  charProcs?: string[];
  /** Adapter errors refuse coverage rather than guessing a missing dictionary. */
  error?: string;
};
export type MissingMapping = { code?: string; cluster?: string; reason: string };
export type EncodeOptions = { preferredCodes?: readonly Uint8Array[] };
export type EncodeResult =
  | { ok: true; codes: Uint8Array[]; bytes: Uint8Array; preferredApplied: boolean }
  | { ok: false; reason: string; firstMissing: string; offset: number };
export type FontCoverage = {
  subtype: string;
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
