import type { PDFDict } from 'pdf-lib';
import { createFontCoverage } from '../fontCoverage/coverage';
import { fontInputFromDict } from '../fontCoverage/pdfLibAdapter';
import { glyphUnicode, simpleNames } from '../fontCoverage/encodings';
import { sameGlyphUnicode } from '../fontCoverage/glyphIdentity';
import { readProgram } from '../fontCoverage/program';
import { codes } from '../contentStreamEdit/runEncoding';
import type { ResolvedRunFont } from '../contentStreamEdit/replaceRun';

/** Use the source program's code-to-outline proof. With a damaged CID map
 * only an already painted code independently read at its stream position
 * may be reused, and only with the actual embedded TrueType outline. */
export function localOutlineProof(raw: PDFDict, font: ResolvedRunFont) {
  const input = fontInputFromDict(raw);
  if (input.error || !input.program || input.fontMatrix) return;
  if (!['TrueType', 'Type0'].includes(input.subtype)) return;
  try {
    const coverage = createFontCoverage(input);
    const program = readProgram(input);
    if (program.kind !== 'fontkit' || program.cff || input.subtype === 'TrueType' && program.symbolic) return;
    const names = input.subtype === 'TrueType' ? simpleNames(input, program.builtIn) : undefined;
    const outline = (code: number, label: string, observed: boolean) => {
      if (names) {
        const name = names.get(code);
        const unicode = name && glyphUnicode(name);
        if (!unicode || !sameGlyphUnicode(unicode, label)) return;
      }
      const key = code.toString(16).padStart(font.bytesPerCode * 2, '0');
      let gid = coverage.glyphIds.get(key);
      const proved = coverage.encodable.get(label)?.some(bytes => codes(bytes, font.bytesPerCode)[0] === code);
      if (!proved) {
        if (!observed || input.subtype !== 'Type0' || input.cidSubtype !== 'CIDFontType2' ||
            input.encoding !== 'Identity-H' || font.unicodeByCode.get(code) !== label) return;
        const map = input.cidToGid;
        if (map instanceof Uint8Array && (map.length % 2 || code * 2 + 1 >= map.length)) return;
        gid = map instanceof Uint8Array ? (map[code * 2]! << 8) | map[code * 2 + 1]! : code;
      }
      try {
        if (!gid || program.presence(gid, label)) return;
        const ink = program.inkBox(gid);
        if (ink && ink.w > 0 && ink.h > 0) return ink;
      } catch {
        return;
      }
    };
    const candidates = (text: string) => (coverage.encodable.get(text) ?? []).map(bytes => codes(bytes, font.bytesPerCode)[0]!);
    return { outline, candidates };
  } catch {
    return;
  }
}
