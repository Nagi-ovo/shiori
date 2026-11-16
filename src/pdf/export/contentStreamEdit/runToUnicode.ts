// Conservative CMap subset for surgical edits. Unlike the legacy overlay
// encoder, validate counts, source widths, Unicode scalars and duplicate codes.
// ToUnicode establishes encoding only; outline coverage is a separate seam.
import { codeInCodespace } from '../fontCoverage/codespace';

export function runToUnicode(program: string, size: 1 | 2): Map<number, string> | null {
  try {
    const source = program.replace(/%[^\r\n]*/g, '');
    // Inherited mappings remain unknown; explicit local entries are authoritative.
    const map = new Map<number, string>();
    const codespaces: [string, string][] = [];
    const tokens = source.match(/<[\da-fA-F\s]*>|\[|\]|[^\s<>[\]]+/g) ?? [];
    const hex = (s: string | undefined, width?: number): string => {
      if (!s || !/^<[\da-fA-F\s]+>$/.test(s)) throw Error('invalid hex');
      const value = s.slice(1, -1).replace(/\s/g, '');
      if (value.length % 2 || (width !== undefined && value.length !== width * 2)) throw Error('bad hex width');
      return value;
    };
    const unicode = (s: string) => {
      const h = hex(s);
      if (h.length % 4) throw Error('invalid UTF16');
      const text = String.fromCharCode(...h.match(/.{4}/g)!.map(v => parseInt(v, 16)));
      if (/[\uD800-\uDFFF]/u.test(Array.from(text).filter(c => c.length === 1).join('')) || text.includes('\0')) throw Error('invalid Unicode');
      return text;
    };
    const put = (code: number, value: string) => {
      if (map.has(code)) throw Error('duplicate source code');
      map.set(code, value);
    };
    for (let i = 0; i < tokens.length; i++) {
      const kind = tokens[i];
      if (kind !== 'beginbfchar' && kind !== 'beginbfrange' && kind !== 'begincodespacerange') {
        if (kind === 'endbfchar' || kind === 'endbfrange' || kind === 'endcodespacerange') throw Error('unbalanced CMap');
        continue;
      }
      const count = Number(tokens[i - 1]);
      if (!Number.isInteger(count) || count < 1 || count > 65536) throw Error('bad section count');
      for (let row = 0; row < count; row++) {
        // Office uses two-byte codespaces with one-byte simple-font sources.
        // Only mapping sources must match the font's code width.
        const width = kind === 'begincodespacerange' ? undefined : size;
        const low = hex(tokens[++i], width), first = parseInt(low, 16);
        if (kind === 'beginbfchar') { put(first, unicode(tokens[++i]!)); continue; }
        const high = hex(tokens[++i], width), last = parseInt(high, 16);
        if (low.length !== high.length || low.length > 8 || last < first) throw Error('bad range');
        if (kind === 'begincodespacerange') { codespaces.push([low, high]); continue; }
        if (last - first > 65535) throw Error('bad range');
        if (tokens[++i] === '[') {
          for (let c = first; c <= last; c++) put(c, unicode(tokens[++i]!));
          if (tokens[++i] !== ']') throw Error('bad array count');
        } else {
          const start = unicode(tokens[i]!);
          const lastUnit = start.charCodeAt(start.length - 1);
          if (lastUnit + last - first > 65535) throw Error('Unicode overflow');
          for (let c = first; c <= last; c++) {
            const value = start.slice(0, -1) + String.fromCharCode(lastUnit + c - first);
            if (/[\uD800-\uDFFF]/u.test(Array.from(value).filter(c => c.length === 1).join(''))) throw Error('invalid Unicode range');
            put(c, value);
          }
        }
      }
      if (tokens[++i] !== (kind === 'beginbfchar' ? 'endbfchar' : kind === 'beginbfrange' ? 'endbfrange' : 'endcodespacerange')) throw Error('bad section length');
    }
    if (codespaces.length && [...map.keys()].some(code => !codespaces.some(([lo, hi]) =>
      codeInCodespace(code.toString(16).padStart(size * 2, '0'), lo, hi)))) return null;
    return map.size ? map : null;
  } catch { return null; }
}
