import {createFontCoverage} from '../fontCoverage/coverage';
import {glyphUnicode, simpleNames} from '../fontCoverage/encodings';
import {sameGlyphUnicode} from '../fontCoverage/glyphIdentity';
import {codeHex, codeNumber, type FontInput} from '../fontCoverage/types';
import {type1RunDiagnostic, type Type1Diagnostic, type Type1Options} from '../fontCoverage/type1Support';
import type {ResolvedRunFont} from './replaceRun';
import {RunCompileError} from './runRefusal';

type Encoding = Pick<ResolvedRunFont, 'canEncode' | 'assertSource'>;
const usable = (label:string) => !!label && !/[\0\r\n\t\uFFFD]/u.test(label);
const placeholder = (label:string|undefined) => label === undefined || /^\uFFFD+$/u.test(label);

const invalidFont = ():never => { throw Error('unsupported or malformed CID TrueType tables'); };
type Tables = Record<string, DataView>;
function cidTables(bytes:Uint8Array):Tables {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength < 12 || ![0x10000, 0x74727565].includes(v.getUint32(0))) return invalidFont();
  const count = v.getUint16(4), tables:Tables = Object.create(null);
  if (count > 256 || 12 + count * 16 > v.byteLength) return invalidFont();
  for (let i = 0; i < count; i++) {
    const p = 12 + i * 16, tag = String.fromCharCode(...bytes.subarray(p, p + 4));
    const offset = v.getUint32(p + 8), length = v.getUint32(p + 12);
    if (tables[tag] || offset < 12 + count * 16 || offset + length > v.byteLength) return invalidFont();
    tables[tag] = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
  }
  return tables;
}

/** Walk only represented entries/ranges. Zero means unknown, -1 ambiguous,
 * otherwise cp+1. Storage is bounded by maxp.numGlyphs, not outline size. */
function cidInverse(cmap:DataView|undefined, numGlyphs:number):Int32Array {
  const inverse = new Int32Array(numGlyphs);
  if (!cmap) return inverse;
  if (cmap.byteLength < 4 || cmap.getUint16(0) !== 0) return invalidFont();
  const count = cmap.getUint16(2), records:{platform:number; encoding:number; offset:number}[] = [];
  if (4 + count * 8 > cmap.byteLength) return invalidFont();
  for (let i = 0; i < count; i++) {
    const p = 4 + i * 8, offset = cmap.getUint32(p + 4);
    if (offset < 4 + count * 8 || offset + 4 > cmap.byteLength) return invalidFont();
    records.push({platform:cmap.getUint16(p), encoding:cmap.getUint16(p + 2), offset});
  }
  // Preserve the existing (3,1) choice; full Unicode and platform-0 tables
  // are fallbacks. Distinct duplicate selection records are not a proof.
  const choices = [[3, 1], [3, 10], [0, 6], [0, 4], [0, 3], [0, 2], [0, 1], [0, 0]];
  const selected = choices.map(([p, e]) => records.filter(r => r.platform === p && r.encoding === e)).find(r => r.length);
  if (!selected) return inverse;
  const offset = selected[0]!.offset;
  if (selected.some(r => r.offset !== offset)) return invalidFont();
  let v = new DataView(cmap.buffer, cmap.byteOffset + offset, cmap.byteLength - offset);
  const format = v.getUint16(0), long = format >= 10;
  if (![0, 4, 6, 10, 12, 13].includes(format) || long && (v.byteLength < 12 || v.getUint16(2))) return invalidFont();
  const length = long ? v.getUint32(4) : v.getUint16(2);
  if (length > v.byteLength || length < (long ? 12 : 6)) return invalidFont();
  v = new DataView(v.buffer, v.byteOffset, length);
  const need = (end:number) => { if (end > length) invalidFont(); };
  const put = (cp:number, gid:number) => {
    if (cp === 0 || cp === 0xfffd || cp >= 0xd800 && cp <= 0xdfff || !gid || gid >= numGlyphs) return;
    const old = inverse[gid]!;
    inverse[gid] = old === 0 || old === cp + 1 ? cp + 1 : -1;
  };
  if (format === 0) {
    need(262);
    for (let cp = 0; cp < 256; cp++) put(cp, v.getUint8(6 + cp));
  } else if (format === 6 || format === 10) {
    need(format === 6 ? 10 : 20);
    const first = format === 6 ? v.getUint16(6) : v.getUint32(12);
    const n = format === 6 ? v.getUint16(8) : v.getUint32(16), start = format === 6 ? 10 : 20;
    need(start + n * 2);
    if (first + n > (format === 6 ? 0x10000 : 0x110000)) return invalidFont();
    for (let i = 0; i < n; i++) put(first + i, v.getUint16(start + i * 2));
  } else if (format === 4) {
    need(16);
    const twice = v.getUint16(6), n = twice / 2;
    if (!n || twice % 2) return invalidFont();
    need(16 + n * 8);
    if (v.getUint16(14 + n * 2)) return invalidFont();
    let previous = -1;
    for (let i = 0; i < n; i++) {
      const first = v.getUint16(16 + n * 2 + i * 2), last = v.getUint16(14 + i * 2);
      const delta = v.getInt16(16 + n * 4 + i * 2), word = 16 + n * 6 + i * 2, range = v.getUint16(word);
      if (first > last || first <= previous || range && (range % 2 || word + range < 16 + n * 8 || word + range + (last - first + 1) * 2 > length)) return invalidFont();
      for (let cp = first; cp <= last; cp++) {
        const raw = range ? v.getUint16(word + range + (cp - first) * 2) : cp;
        put(cp, range && raw === 0 ? 0 : (raw + delta) & 65535);
      }
      previous = last;
    }
  } else {
    need(16);
    const n = v.getUint32(12); need(16 + n * 12);
    let previous = -1;
    for (let i = 0; i < n; i++) {
      const p = 16 + i * 12, first = v.getUint32(p), last = v.getUint32(p + 4), gid = v.getUint32(p + 8);
      if (first > last || first <= previous || last > 0x10ffff || gid + (format === 12 ? last - first : 0) > 0xffffffff) return invalidFont();
      if (gid > 0 && gid < numGlyphs) for (let cp = first, end = format === 12 ? Math.min(last, first + numGlyphs - 1 - gid) : last; cp <= end; cp++) {
        put(cp, gid + (format === 12 ? cp - first : 0));
        // A constant-GID range is unknown as soon as two scalars prove it
        // ambiguous; there is no need to expand the rest of the range.
        if (format === 13 && inverse[gid] === -1) break;
      }
      // A format-12 range starting at .notdef can still contain valid GIDs.
      if (format === 12 && gid === 0) for (let cp = first + 1; cp <= Math.min(last, first + numGlyphs - 1); cp++) put(cp, cp - first);
      previous = last;
    }
  }
  return inverse;
}

// The 258 standard post names (OpenType Macintosh glyph order), not a CID
// character encoding. Only post versions that explicitly select them use it.
const postNames = '.notdef .null nonmarkingreturn space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis nonbreakingspace Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron Lslash lslash Scaron scaron Zcaron zcaron brokenbar Eth eth Yacute yacute Thorn thorn minus multiply onesuperior twosuperior threesuperior onehalf onequarter threequarters franc Gbreve gbreve Idotaccent Scedilla scedilla Cacute cacute Ccaron ccaron dcroat'.split(' ');

/** Read names without constructing glyphs or decoding outlines. */
function cidPost(post:DataView|undefined, numGlyphs:number):(gid:number)=>string|undefined {
  if (!post || post.byteLength < 32) return () => undefined;
  const version = post.getUint32(0);
  if (version === 0x10000) return gid => postNames[gid];
  if (version !== 0x20000 && version !== 0x25000) return () => undefined;
  if (post.byteLength < 34) return invalidFont();
  const count = post.getUint16(32), width = version === 0x20000 ? 2 : 1;
  if (count > numGlyphs || 34 + count * width > post.byteLength) return invalidFont();
  if (width === 1) return gid => gid < count ? postNames[gid + post.getInt8(34 + gid)] : undefined;
  let max = 257;
  for (let i = 0; i < count; i++) max = Math.max(max, post.getUint16(34 + i * 2));
  const names:string[] = [];
  for (let i = 258, p = 34 + count * 2; i <= max; i++) {
    if (p >= post.byteLength) return invalidFont();
    const length = post.getUint8(p++);
    if (p + length > post.byteLength) return invalidFont();
    const bytes = new Uint8Array(post.buffer, post.byteOffset + p, length);
    names.push(String.fromCharCode(...bytes)); p += length;
  }
  return gid => {
    if (gid >= count) return;
    const index = post.getUint16(34 + gid * 2);
    return index < 258 ? postNames[index] : names[index - 258];
  };
}

/** Structural glyf proof equivalent to decoding a path, without allocating
 * points/commands. Cache one validity byte per GID; composites cannot expand
 * recursively or keep fontkit's outline graph alive. */
function cidPresence(tables:Tables, count:number):(gid:number, label:string)=>boolean {
  const {head, loca, glyf} = tables;
  if (!head || head.byteLength < 54 || !loca || !glyf) return invalidFont();
  const format = head.getInt16(50), width = format === 0 ? 2 : 4;
  if (![0, 1].includes(format) || loca.byteLength < (count + 1) * width) return invalidFont();
  const offset = (gid:number) => width === 2 ? loca.getUint16(gid * 2) * 2 : loca.getUint32(gid * 4);
  const state = new Uint8Array(count);
  const valid = (gid:number, depth:number):boolean => {
    if (gid >= count || depth > 32 || state[gid] === 1 || state[gid] === 2) return false;
    if (state[gid] === 3) return true;
    state[gid] = 1;
    try {
      const start = offset(gid), end = offset(gid + 1);
      if (end < start || end > glyf.byteLength || end !== start && end - start < 10) throw Error();
      if (end > start) {
        const v = new DataView(glyf.buffer, glyf.byteOffset + start, end - start);
        const contours = v.getInt16(0);
        let p = 10;
        if (contours > 0) {
          let last = -1;
          for (let i = 0; i < contours; i++, p += 2) {
            const point = v.getUint16(p); if (point <= last) throw Error(); last = point;
          }
          p += 2 + v.getUint16(p);
          let points = 0, coords = 0;
          while (points <= last) {
            const flags = v.getUint8(p++), n = flags & 8 ? 1 + v.getUint8(p++) : 1;
            points += n;
            coords += n * ((flags & 2 ? 1 : flags & 16 ? 0 : 2) + (flags & 4 ? 1 : flags & 32 ? 0 : 2));
          }
          if (points !== last + 1 || p + coords > v.byteLength) throw Error();
        } else if (contours < 0) {
          if (contours !== -1) throw Error();
          let flags:number, instructions = false;
          do {
            flags = v.getUint16(p);
            const component = v.getUint16(p + 2);
            p += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 64 ? 4 : flags & 128 ? 8 : 0);
            if (p > v.byteLength || !valid(component, depth + 1)) throw Error();
            instructions ||= !!(flags & 256);
          } while (flags & 32);
          if (instructions && p + 2 + v.getUint16(p) > v.byteLength) throw Error();
        }
      }
      state[gid] = 3; return true;
    } catch { state[gid] = 2; return false; }
  };
  return (gid, label) => valid(gid, 0) && (offset(gid) !== offset(gid + 1) || /^[\p{White_Space}\p{M}\p{Cf}]+$/u.test(label));
}

/** Identity-H is a CID mapping, never Unicode. The recovery owns only views,
 * scalar maps and validity bytes; none survive in the returned encoder. */
function cidLabels(input:FontInput) {
  const labels = new Map<string, string|null>(), verified = new Set<string>();
  if (input.encoding !== 'Identity-H' || input.cidSubtype !== 'CIDFontType2' || !input.program) return {labels, verified};
  const tables = cidTables(input.program), maxp = tables.maxp;
  if (!maxp || maxp.byteLength < 6 || !tables.glyf) return {labels, verified};
  const numGlyphs = maxp.getUint16(4);
  if (!numGlyphs) return {labels, verified};
  const inverse = cidInverse(tables.cmap, numGlyphs), present = cidPresence(tables, numGlyphs);
  let nameFor:ReturnType<typeof cidPost>|undefined;
  const map = input.cidToGid;
  if (map instanceof Uint8Array && map.length % 2) return {labels, verified};
  const count = map instanceof Uint8Array ? Math.min(map.length / 2, 65536) : numGlyphs;
  for (let cid = 0; cid < count; cid++) {
    const gid = map instanceof Uint8Array ? map[cid * 2]! * 256 + map[cid * 2 + 1]! : cid;
    if (!gid || gid >= numGlyphs) continue;
    const cp = inverse[gid]!;
    let label:string|null|undefined = cp < 0 ? null : cp > 0 ? String.fromCodePoint(cp - 1) : undefined;
    if (label === undefined || label !== null && !usable(label)) {
      nameFor ??= cidPost(tables.post, numGlyphs);
      const name = nameFor(gid); label = name ? glyphUnicode(name) : undefined;
    }
    const hex = cid.toString(16).padStart(4, '0');
    if (label !== undefined) labels.set(hex, label);
    if (label && usable(label) && present(gid, label)) verified.add(hex);
  }
  return {labels, verified};
}

const cmapText = (labels:ReadonlyMap<string, string>) => {
  const utf16 = (s:string) => Array.from({length:s.length}, (_, i) => s.charCodeAt(i).toString(16).padStart(4, '0')).join('');
  return `${labels.size} beginbfchar ${[...labels].map(([hex, text]) => `<${hex}> <${utf16(text)}>`).join(' ')} endbfchar`;
};
function refuse(diagnostic:Type1Diagnostic):never {
  const d = type1RunDiagnostic(diagnostic);
  throw Object.assign(new RunCompileError(d.detail, d.code), {terminal:d.terminal, diagnostic});
}

/** Source labels and replacement eligibility are independent. Embedded
 * inferred labels need a presence proof; published non-embedded labels are
 * source-only. Neither changes the original encoder's coverage/ToUnicode. */
export function recoverRunUnicode(input:FontInput, size:1|2, original:ReadonlyMap<number, string>|null,
  encoding:Encoding, options:Type1Options):Encoding & Pick<ResolvedRunFont, 'unicodeByCode'> {
  const labels = new Map(original ?? []), conflicts = new Map<number, string>();
  for (const [code, label] of labels) if (label.includes('\uFFFD')) labels.delete(code);
  try {
    if (input.error) throw Error(input.error);
    // A refused ToUnicode supplies no labels or edit authority. Independent
    // Encoding/AGL and embedded-program proofs must still get a chance.
    const cid = size === 2 ? cidLabels(input) : undefined;
    const enc = input.encoding;
    const sourceOnly = size === 1 && !input.program && !((input.flags ?? 0) & 4)
      && !!(typeof enc === 'string' ? enc : enc?.base || Object.keys(enc?.differences ?? {}).length);
    const inferred = sourceOnly ? new Map<string, string>() : size === 1
      ? createFontCoverage({...input, toUnicode:undefined}, {...options, sourceReuse:true}).codeToUnicode
      : cid!.labels;
    if (sourceOnly) {
      const base = typeof enc === 'string' ? enc : enc?.base;
      for (const [code, name] of simpleNames(input)) {
        // Without a published base, only explicit Differences prove names.
        if (!base && (typeof enc !== 'object' || enc.differences?.[code] === undefined)) continue;
        // Do not infer non-standard ligatures such as f_h from their spelling.
        if (name.split('.')[0]!.includes('_')) continue;
        const label = glyphUnicode(name);
        if (label) inferred.set(code.toString(16).padStart(2, '0'), label);
      }
    }
    const candidates = new Map<string, string>();
    for (const [hex, label] of inferred) {
      if (hex.length !== size * 2) continue;
      const code = codeNumber(hex), explicit = original?.get(code);
      if (explicit && usable(explicit) && (label === null || !sameGlyphUnicode(label, explicit))) {
        conflicts.set(code, `ToUnicode ${JSON.stringify(explicit)} disagrees with selected glyph (${JSON.stringify(label)})`);
      }
      if (label && usable(label) && placeholder(explicit)) candidates.set(hex, label);
    }
    if (sourceOnly) {
      // Published Encoding + AGL proves source text, never reusable outlines.
      for (const [hex, label] of candidates) labels.set(codeNumber(hex), label);
    } else if (cid) {
      // CID labels already have a table-only glyph-presence proof. Passing
      // them through generic coverage would decode every candidate outline.
      for (const [hex, label] of candidates) if (cid.verified.has(hex)) labels.set(codeNumber(hex), label);
    } else if (candidates.size) {
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
