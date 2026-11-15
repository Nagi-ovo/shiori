import fontkit from '@pdf-lib/fontkit';
import type {Font} from '@pdf-lib/fontkit';
import {createFontCoverage} from '../fontCoverage/coverage';
import {parseCMap} from '../fontCoverage/cmap';
import {glyphUnicode} from '../fontCoverage/encodings';
import {trueTypeCmaps} from '../fontCoverage/trueTypeCmap';
import {codeHex, codeNumber, type FontInput} from '../fontCoverage/types';
import {type1RunDiagnostic, type Type1Diagnostic, type Type1Options} from '../fontCoverage/type1Support';
import type {ResolvedRunFont} from './replaceRun';
import {RunCompileError} from './runRefusal';

type Encoding = Pick<ResolvedRunFont, 'canEncode' | 'assertSource'>;
const usable = (label:string) => !!label && !/[\0\r\n\t\uFFFD]/u.test(label);
const placeholder = (label:string|undefined) => label === undefined || /^\uFFFD+$/u.test(label);

/** Identity-H is a CID mapping, never a Unicode encoding. Recover a label only
 * from the actual selected GID's name or an unambiguous Unicode cmap inverse. */
function cidLabels(input:FontInput):Map<string, string|null> {
  const labels = new Map<string, string|null>();
  if (input.encoding !== 'Identity-H' || input.cidSubtype !== 'CIDFontType2' || !input.program) return labels;
  const font = fontkit.create(input.program) as Font & {directory:{tables:Record<string, {offset:number;length:number}>}};
  if (!font.directory.tables.glyf || !Number.isInteger(font.numGlyphs) || font.numGlyphs > 65535) return labels;
  const cmap = trueTypeCmaps(input.program, font.directory.tables.cmap)(3, 1);
  const inverse = new Map<number, string|null>();
  if (cmap) for (let cp = 1; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff || cp === 0xfffd) continue;
    const gid = cmap(cp); if (!gid || gid >= font.numGlyphs) continue;
    inverse.set(gid, inverse.has(gid) ? null : String.fromCodePoint(cp));
  }
  const map = input.cidToGid;
  if (map instanceof Uint8Array && map.length % 2) return labels;
  const count = map instanceof Uint8Array ? Math.min(map.length / 2, 65536) : font.numGlyphs;
  for (let cid = 0; cid < count; cid++) {
    const gid = map instanceof Uint8Array ? map[cid * 2]! * 256 + map[cid * 2 + 1]! : cid;
    if (!gid || gid >= font.numGlyphs) continue;
    const name = (font.getGlyph(gid) as unknown as {name?:string}).name;
    const named = name ? glyphUnicode(name) : undefined, unicode = inverse.get(gid);
    const label = unicode === null || named && unicode && named !== unicode ? null : named ?? unicode;
    if (label !== undefined) labels.set(cid.toString(16).padStart(4, '0'), label);
  }
  return labels;
}

const cmapText = (labels:ReadonlyMap<string, string>) => {
  const utf16 = (s:string) => Array.from({length:s.length}, (_, i) => s.charCodeAt(i).toString(16).padStart(4, '0')).join('');
  return `${labels.size} beginbfchar ${[...labels].map(([hex, text]) => `<${hex}> <${utf16(text)}>`).join(' ')} endbfchar`;
};
function refuse(diagnostic:Type1Diagnostic):never {
  const d = type1RunDiagnostic(diagnostic);
  throw Object.assign(new RunCompileError(d.detail, d.code), {terminal:d.terminal, diagnostic});
}

/** Source labels and replacement eligibility are independent. A temporary
 * coverage report verifies inferred labels; it never installs a ToUnicode or
 * changes the original encoder's coverage/proof. */
export function recoverRunUnicode(input:FontInput, size:1|2, original:ReadonlyMap<number, string>|null,
  encoding:Encoding, options:Type1Options):Encoding & Pick<ResolvedRunFont, 'unicodeByCode'> {
  const labels = new Map(original ?? []), conflicts = new Map<number, string>();
  for (const [code, label] of labels) if (label.includes('\uFFFD')) labels.delete(code);
  try {
    if (input.error) throw Error(input.error);
    // An empty valid CMap is recoverable; malformed/unsupported maps retain
    // the strict parser's refusal instead of being treated as missing.
    if (original === null && input.toUnicode !== undefined && parseCMap(input.toUnicode).unicode.size) throw Error('invalid surgical ToUnicode');
    const inferred = size === 1
      ? createFontCoverage({...input, toUnicode:undefined}, {...options, sourceReuse:true}).codeToUnicode
      : cidLabels(input);
    const candidates = new Map<string, string>();
    for (const [hex, label] of inferred) {
      if (hex.length !== size * 2) continue;
      const code = codeNumber(hex), explicit = original?.get(code);
      if (explicit && usable(explicit) && (label === null || label !== explicit)) {
        conflicts.set(code, `ToUnicode ${JSON.stringify(explicit)} disagrees with selected glyph (${JSON.stringify(label)})`);
      }
      if (label && usable(label) && placeholder(explicit)) candidates.set(hex, label);
    }
    if (candidates.size) {
      // Re-run the existing code -> glyph proof with candidate labels. This
      // rejects .notdef, absent outlines, invalid names, symbolic ambiguities,
      // and Type1 identity/metrics failures before a label enters evidence.
      const proof = createFontCoverage({...input, toUnicode:cmapText(candidates)}, {...options, sourceReuse:true});
      for (const [label, codes] of proof.encodable) for (const bytes of codes) {
        const hex = codeHex(bytes);
        if (bytes.length === size && candidates.get(hex) === label) labels.set(codeNumber(hex), label);
      }
    }
  } catch { /* Unknown provenance remains unknown; explicit valid labels survive. */ }

  return {
    unicodeByCode:labels,
    assertSource:codes => {
      for (const bytes of codes) {
        const code = codeNumber(codeHex(bytes)), conflict = conflicts.get(code);
        if (conflict) refuse({code:'glyph-identity-conflict', detail:conflict});
      }
      // A missing label must not hide a terminal failure on a different
      // addressed code. Placeholder labels have no replacement identity.
      encoding.assertSource?.(codes.filter(bytes => {
        const code = codeNumber(codeHex(bytes));
        return labels.get(code) === original?.get(code);
      }));
      for (const bytes of codes) {
        const code = codeNumber(codeHex(bytes)), label = labels.get(code);
        if (label && original?.get(code) !== label) throw new RunCompileError(
          `source label recovered for ${codeHex(bytes)}; replacement requires a ToUnicode label`, 'font-unavailable');
      }
    },
    canEncode:encoding.canEncode && ((text, preferred) => {
      const encoded = encoding.canEncode!(text, preferred);
      if (!encoded.ok) return encoded;
      for (const bytes of encoded.codes) {
        const conflict = conflicts.get(codeNumber(codeHex(bytes)));
        if (conflict) refuse({code:'glyph-identity-conflict', detail:conflict});
      }
      const values = encoded.codes.map(bytes => original?.get(codeNumber(codeHex(bytes))));
      if (values.some(label => !label || !usable(label)) || values.join('') !== text) return {ok:false,
        reason:'replacement requires a ToUnicode label', firstMissing:Array.from(text)[0] ?? '', offset:0};
      return encoded;
    }),
  };
}
