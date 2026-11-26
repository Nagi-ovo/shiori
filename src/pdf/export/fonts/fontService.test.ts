import { expect, test } from 'bun:test';
import { fallbackFontName } from '../contentStreamEdit/fallbackFont';
import { substituteFontName } from '../contentStreamEdit/substituteFonts';
import { format4Points, sfnt, tinyTtf } from '../fontCoverage/fixtures/programs';
import { cjkRegion, fontRequestsForParagraph, resolveFont, type FontRequest } from './fontService';
import { localFontBytes } from './localFonts';

const purposes = ['cluster-fallback', 'run-substitute', 'vertical', 'retypeset'] as const;
const request: FontRequest = {
  purpose: 'cluster-fallback', baseFont: 'ABCDEF+LocalText-Regular', flags: 0, text: 'A',
};

test.each([
  ['subset sans at bold weight','ABCDEF+Calibri', 0, 'é', 600, 'Carlito-Bold.ttf'],
  ['italic serif','Cambria-Italic', 0, 'é', 400, 'Caladea-Italic.ttf'],
  ['italic serif with a missing glyph','Cambria-Italic', 0, 'A\u0304', 600, 'LiberationSerif-BoldItalic.ttf'],
  ['geometric sans','AvantGarde-Book', 64, 'é', 400, 'TeXGyreAdventor-Italic.otf'],
  ['geometric sans with a missing glyph','AvantGarde-Book', 64, 'Ā', 400, 'LiberationSans-Italic.ttf'],
  ['bold typesetting serif','CMBX10', 0, 'A', 400, 'LiberationSerif-Bold.ttf'],
  ['italic typesetting serif','CMMI10', 0, 'A', 400, 'LiberationSerif-Italic.ttf'],
  ['typesetting sans below bold weight','LMSans', 0, 'A', 599, 'LiberationSans-Regular.ttf'],
  ['typesetting mono','CMTT10', 0, 'A', 400, 'LiberationMono-Regular.ttf'],
  ['fixed-pitch style flags','Unknown', 1 | 64 | (1 << 18), 'A', 400, 'LiberationMono-BoldItalic.ttf'],
] as const)('uses the same Latin selection for %s', (_label, baseFont, flags, text, weight, name) => {
  for (const purpose of purposes) {
    expect(resolveFont({ purpose, baseFont, flags, text, weight })).toMatchObject({
      name, source: 'bundled', reason: 'family-table',
    });
  }
});

test('the name-only entry points apply the resolver style and family rules', () => {
  expect(fallbackFontName('Cambria-Italic', 0, 'é', 600)).toBe('Caladea-BoldItalic.ttf');
  expect(substituteFontName('Calibri', 0, 'é')).toBe('Carlito-Regular.ttf');
  expect(fallbackFontName('Arial-Bold', 0, '漢字')).toBe('NotoSansSC-Bold.otf');
  expect(substituteFontName('Arial-BoldItalic', 64, '한국어')).toBe('NotoSansKR-Bold.otf');
});

test.each([
  ['漢한ｶ', 'Korea1', 'ko', 'JP'],
  ['漢한', 'Japan1', 'ja', 'KR'],
  ['𠀀', 'Japan1', 'zh-CN', 'JP'],
  ['漢字', 'GB1', 'zh-Hant', 'SC'],
  ['漢字', 'CNS1', 'ja', 'TC'],
  ['漢字', 'Korea1', 'ja', 'KR'],
  ['漢字', 'Identity', 'ja-JP', 'JP'],
  ['漢字', undefined, 'ko-KR', 'KR'],
  ['漢字', undefined, 'zh-Hant', 'TC'],
  ['漢字', undefined, 'ZH-TW', 'TC'],
  ['漢字', undefined, 'zh-HK', 'TC'],
  ['漢字', undefined, 'zh-Hans-MO', 'TC'],
  ['漢字', undefined, 'zh-Hans', 'SC'],
  ['漢字', undefined, 'zh-x-tw', 'SC'],
  ['漢・字', undefined, undefined, 'SC'],
  ['漢ー', 'GB1', 'zh-CN', 'JP'],
  ['Latin', 'Japan1', 'ja', undefined],
] as const)('selects the region for %s / %s / %s', (text, ordering, lang, region) => {
  expect(cjkRegion(text, ordering, lang)).toBe(region);
});

test('reports the regional signal and uses the regional bold face for every purpose', () => {
  for (const purpose of purposes) {
    expect(resolveFont({ ...request, purpose, text: '漢', cidOrdering: 'GB1', lang: 'ja', weight: 600, flags: 64 }))
      .toEqual({ name: 'NotoSansSC-Bold.otf', family: 'NotoSansSC', style: 'Bold', source: 'bundled', region: 'SC', reason: 'cid-ordering' });
  }
  expect(resolveFont({ ...request, text: '漢', lang: 'ja' })).toMatchObject({ name: 'NotoSansJP-Regular.otf', region: 'JP', reason: 'lang' });
  expect(resolveFont({ ...request, text: '한', lang: 'ja' })).toMatchObject({ name: 'NotoSansKR-Regular.otf', region: 'KR', reason: 'script' });
  expect(resolveFont({ ...request, text: '漢' })).toMatchObject({ name: 'NotoSansSC-Regular.otf', region: 'SC' });
});

// A paragraph can supply script for a neutral hole. Its kana or Hangul must
// not erase an individual Han cluster's CID ordering or source language.
test.each([
  ['漢字です', '漢', 'GB1', 'ja', 'SC', 'cid-ordering'],
  ['漢字한글', '漢', 'Japan1', 'ko', 'JP', 'cid-ordering'],
  ['漢字です', '漢', 'Identity', 'ko', 'KR', 'lang'],
  ['漢字です', 'é', 'GB1', 'zh', 'JP', 'script'],
  ['漢字한글', '、', 'Japan1', 'ja', 'KR', 'script'],
] as const)('selects the drawn cluster %s / %s / %s / %s', (paragraph, text, cidOrdering, lang, region, reason) => {
  const withParagraph = fontRequestsForParagraph(paragraph);
  for (const purpose of purposes) {
    expect(resolveFont(withParagraph({ ...request, purpose, text, cidOrdering, lang }))).toMatchObject({
      name: `NotoSans${region}-Regular.otf`, region, reason,
    });
  }
});

test.each(['A', '7', 'É'])('vertical %s stays Latin in a Latin paragraph with a CJK CID font', text => {
  const bare: FontRequest = { ...request, purpose: 'vertical', text, cidOrdering: 'Japan1' };
  expect(resolveFont(bare).name).toBe('LiberationSans-Regular.ttf');
  expect(resolveFont(fontRequestsForParagraph('Area 7')(bare))).toEqual(resolveFont(bare));
});

test('vertical neutral punctuation inherits Han context or signals its own CJK script extensions', () => {
  const vertical: FontRequest = { ...request, purpose: 'vertical', text: '.', cidOrdering: 'GB1' };
  expect(resolveFont(fontRequestsForParagraph('漢字.')(vertical)).name).toBe('NotoSansSC-Regular.otf');
  expect(resolveFont(fontRequestsForParagraph('、')({ ...vertical, text: '、' })).name).toBe('NotoSansSC-Regular.otf');
});

test.each(['SourceMincho', 'SourceSong'])('uses the shared Latin table for %s and honors the serif flag', baseFont => {
  for (const purpose of purposes) {
    expect(resolveFont({ ...request, purpose, baseFont }).name).toBe('LiberationSans-Regular.ttf');
    expect(resolveFont({ ...request, purpose, baseFont, flags: 2 }).name).toBe('LiberationSerif-Regular.ttf');
  }
});

function localProgram({
  family = 'Local Text', postscript = 'LocalText-Regular', subfamily = 'Regular',
  text = 'A漢', fsType = 0, traditional = false, width = 500, truncatePermissions = false,
} = {}) {
  const entries = Array.from(text, (c, i): [number, number] => [c.codePointAt(0)!, i + 1]);
  const source = tinyTtf({ maps: [{ platform: 3, encoding: 1, entries, subtable: format4Points(entries) }] });
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const tables: Record<string, Uint8Array> = {};
  for (let i = 0; i < view.getUint16(4); i++) {
    const p = 12 + i * 16, offset = view.getUint32(p + 8), length = view.getUint32(p + 12);
    tables[new TextDecoder().decode(source.subarray(p, p + 4))] = source.slice(offset, offset + length);
  }
  // Windows Unicode names. Use the names inside the font independently of its file name.
  const u16 = (n: number) => [n >>> 8 & 255, n & 255];
  const strings: number[] = [];
  const names = ([[1, family], [2, subfamily], [6, postscript]] as const).flatMap(([id, value]) => {
    const utf16 = Array.from(value, char => u16(char.charCodeAt(0))).flat();
    const record = [3, 1, 0x409, id, utf16.length, strings.length].flatMap(u16);
    strings.push(...utf16);
    return record;
  });
  tables.name = Uint8Array.from([...[0, 3, 42].flatMap(u16), ...names, ...strings]);
  tables['OS/2'] = new Uint8Array(86);
  const os2 = new DataView(tables['OS/2'].buffer);
  os2.setUint16(0, 1);
  os2.setUint16(4, subfamily === 'Bold' ? 700 : 400);
  os2.setUint16(8, fsType);
  if (traditional) os2.setUint32(78, 1 << 20); // Windows code page 950.
  new DataView(tables.hmtx!.buffer).setUint16(4, width);
  const bytes = sfnt(tables);
  if (truncatePermissions) {
    // The data after this record's declared boundary is outside the table.
    const directory = new DataView(bytes.buffer);
    const os2Index = Object.keys(tables).sort((a, b) => a.localeCompare(b)).indexOf('OS/2');
    directory.setUint32(12 + 16 * os2Index + 12, 8);
  }
  return bytes;
}

test('chooses a matching local face by internal family and requested style', () => {
  const regular = { name: 'a.ttf', bytes: localProgram() };
  const bold = { name: 'z.ttf', bytes: localProgram({ subfamily: 'Bold', postscript: 'LocalText-Bold' }) };
  const choice = resolveFont({ ...request, baseFont: 'ABCDEF+LocalText-Bold', weight: 600 }, { localFonts: [regular, bold] });
  expect(choice).toEqual({ name: 'z.ttf', family: 'Local Text', style: 'Bold', source: 'local', reason: 'local-match' });
  expect(localFontBytes(choice)).toEqual(bold.bytes);
});

test('rejects malformed programs, subset names, missing glyphs, and misleading file names', () => {
  const localFonts = [
    { name: 'broken.ttf', bytes: Uint8Array.of(0, 1, 0, 0, 0, 10) },
    { name: 'subset.ttf', bytes: localProgram({ postscript: 'ABCDEF+LocalText-Regular' }) },
    { name: 'missing-A.ttf', bytes: localProgram({ text: 'B漢' }) },
    { name: 'LocalText-Regular.ttf', bytes: localProgram({ family: 'Other Family', postscript: 'OtherFamily-Regular' }) },
  ];
  const choice = resolveFont(request, { localFonts });
  expect(choice).toEqual({ name: 'LiberationSans-Regular.ttf', family: 'LiberationSans', style: 'Regular', source: 'bundled', reason: 'family-table' });
  expect(localFontBytes(choice)).toBeUndefined();
});

test.each([
  [2, 'restricted'], [4, 'preview and print only'], [0x100, 'no subsetting'], [0x200, 'bitmap only'],
] as const)('uses the bundled face when fsType %s is %s', (fsType) => {
  const choice = resolveFont(request, { localFonts: [{ name: 'restricted.ttf', bytes: localProgram({ fsType }) }] });
  expect(choice).toMatchObject({ source: 'bundled', reason: 'local-permission-denied' });
  expect(localFontBytes(choice)).toBeUndefined();
});

test.each([0, 8, 12])('accepts the existing embedding policy for fsType %s', (fsType) => {
  const choice = resolveFont(request, { localFonts: [{ name: 'editable.ttf', bytes: localProgram({ fsType }) }] });
  expect(choice).toMatchObject({ name: 'editable.ttf', source: 'local', reason: 'local-match' });
});

test('an incomplete OS/2 table cannot grant local embedding permission', () => {
  const choice = resolveFont(request, {
    localFonts: [{ name: 'incomplete.ttf', bytes: localProgram({ truncatePermissions: true }) }],
  });
  expect(choice).toMatchObject({ source: 'bundled', reason: 'local-permission-denied' });
});

test('a font family ending in a style word still has its own identity', () => {
  const day = { name: 'day.ttf', bytes: localProgram({ family: 'Day', postscript: 'Day-Regular' }) };
  const daylight = { name: 'daylight.ttf', bytes: localProgram({ family: 'DayLight', postscript: 'DayLight' }) };
  for (const baseFont of ['Daylight', 'DayLight']) {
    expect(resolveFont({ ...request, baseFont }, { localFonts: [day] }).source).toBe('bundled');
    expect(resolveFont({ ...request, baseFont }, { localFonts: [day, daylight] }).name).toBe('daylight.ttf');
  }
  expect(resolveFont({ ...request, baseFont: 'Day' }, { localFonts: [daylight] }).source).toBe('bundled');
});

test.each([['serif', 'Times New Roman'], ['mono', 'Courier New']])('matches conventional %s PostScript names to the local family and style', (_label, family) => {
  const stem = family.replaceAll(' ', '') + 'PS';
  const regular = { name: 'a.ttf', bytes: localProgram({ family, postscript: `${stem}MT` }) };
  const bold = { name: 'b.ttf', bytes: localProgram({ family, postscript: `${stem}-BoldMT`, subfamily: 'Bold' }) };
  const boldAlias = { name: '0.ttf', bytes: localProgram({ family, postscript: `${family.replaceAll(' ', '')}-Bold`, subfamily: 'Bold' }) };
  const italic = { name: 'i.ttf', bytes: localProgram({ family, postscript: `${stem}-ItalicMT`, subfamily: 'Italic' }) };
  const localFonts = [regular, boldAlias, bold, italic];
  for (const [suffix, face, style] of [['MT', regular, 'Regular'], ['-BoldMT', bold, 'Bold'], ['-ItalicMT', italic, 'Italic']] as const) {
    const styled = { ...request, baseFont: `ABCDEF+${stem}${suffix}` };
    expect(resolveFont(styled, { localFonts })).toMatchObject({ name: face.name, style });
    expect(resolveFont(styled, { localFonts: [regular] }).name).toBe(regular.name);
  }
  expect(resolveFont({ ...request, baseFont: `${stem}MT` }, { localFonts: [bold] }).name).toBe(bold.name);
  expect(resolveFont({ ...request, baseFont: `${stem}MT`, weight: 700 }, { localFonts: [regular, bold] }).name).toBe(bold.name);
});

test('vendor suffixes in unrelated names are part of those names', () => {
  const day = { name: 'day.ttf', bytes: localProgram({ family: 'Day', postscript: 'Day-Regular' }) };
  const dayPS = { name: 'day-ps.ttf', bytes: localProgram({ family: 'DayPS', postscript: 'DayPS-Regular' }) };
  for (const baseFont of ['DayPS', 'DayMT', 'DayPS-BoldMT', 'DayMT-Bold', 'DayPSMT']) {
    expect(resolveFont({ ...request, baseFont }, { localFonts: [day] }).source).toBe('bundled');
  }
  expect(resolveFont({ ...request, baseFont: 'DayPS-BoldMT' }, { localFonts: [day, dayPS] }).name).toBe('day-ps.ttf');
});

test('TC selects a permitted TC-capable family match and otherwise reports the SC substitute', () => {
  const tc = { ...request, text: '漢', cidOrdering: 'CNS1', lang: 'ja' };
  const ordinary = { name: 'ordinary.ttf', bytes: localProgram() };
  const traditional = { name: 'traditional.ttf', bytes: localProgram({ traditional: true }) };
  const unrelated = { name: 'unrelated.ttf', bytes: localProgram({ family: 'Unrelated', postscript: 'Unrelated-Regular', traditional: true }) };
  const fallback = resolveFont(tc, { localFonts: [ordinary, unrelated] });
  expect(fallback).toMatchObject({ name: 'NotoSansSC-Regular.otf', source: 'bundled', region: 'TC' });
  expect(fallback.reason).toContain('cid-ordering');
  expect(fallback.reason).toContain('tc-fallback');
  expect(resolveFont(tc, { localFonts: [ordinary, traditional] })).toMatchObject({
    name: 'traditional.ttf', source: 'local', region: 'TC', reason: 'local-match',
  });
});

test('duplicate local names always retrieve the validated face, even after the inputs change', () => {
  const denied = { name: 'same.ttf', bytes: localProgram({ fsType: 2 }) };
  const first = { name: 'same.ttf', bytes: localProgram({ width: 300 }) };
  const second = { name: 'same.ttf', bytes: localProgram({ width: 700 }) };
  const forward = resolveFont(request, { localFonts: [denied, first, second] });
  const reverse = resolveFont(request, { localFonts: [second, first, denied] });
  expect(forward).toEqual(reverse);
  expect(forward).toMatchObject({ name: 'same.ttf', source: 'local', reason: 'local-match' });
  const selected = localFontBytes(forward);
  expect(selected).toEqual(localFontBytes(reverse));
  expect([first.bytes, second.bytes]).toContainEqual(selected);
  const copy = selected!.slice();
  first.bytes.fill(0);
  second.bytes.fill(0);
  expect(localFontBytes(forward)).toEqual(copy);
});
