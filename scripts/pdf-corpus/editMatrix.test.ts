import {expect, test} from 'bun:test';
import {editMatrix} from './editMatrix';

function overflowTexts(original: string) {
  return ['overflow', 'overflow-2'].map(kind => {
    const edit = editMatrix(original).find(e => e.kind === kind);
    expect(edit, kind).toBeDefined();
    return edit!.text;
  });
}
const length = (text: string) => Array.from(text).length;

test.each([
  'The report describes how the current layout should handle these changes.',
  '这份说明介绍了当前情况和需要调整的内容，并进一步说明如何根据实际需要进行处理，以便大家了解相关情况。',
  'この説明では現在の状況と調整が必要な内容を確認し、実際の使い方に合わせて変更する方法について詳しく紹介します。',
])('realistic overflow appends mild and stronger clauses inside the growth band: %s', original => {
  const edits = overflowTexts(original);
  for (const [i, text] of edits.entries()) {
    expect(text.startsWith(original)).toBe(true);
    const ratio = length(text) / length(original);
    expect(ratio).toBeGreaterThanOrEqual(1.1);
    expect(ratio).toBeLessThanOrEqual(1.6);
    expect(Math.abs(ratio - [1.25, 1.55][i]!)).toBeLessThanOrEqual(0.08);
  }
  expect(length(edits[0]!)).toBeLessThan(length(edits[1]!));
});

test('Latin overflow adds real words separated by spaces and preserves existing whitespace', () => {
  for (const original of ['Hello world', 'Hello world ', 'Hello world\t']) {
    for (const text of overflowTexts(original)) {
      expect(text.startsWith(original)).toBe(true);
      const suffix = text.slice(original.length);
      expect(suffix.trim()).toMatch(/^[a-z]+(?: [a-z]+)+$/);
      expect(text).not.toBe('Hello'.repeat(8) + original.slice(5));
      expect(/\s$/.test(original) ? suffix : suffix.slice(1)).toBe(suffix.trim());
      if (!/\s$/.test(original)) expect(suffix.startsWith(' ')).toBe(true);
    }
  }
});

test('short lines still receive natural phrases even beyond sixty percent growth', () => {
  for (const original of ['Hi', '中', 'の']) {
    for (const text of overflowTexts(original)) {
      expect(text.startsWith(original)).toBe(true);
      expect(length(text)).toBeGreaterThan(length(original) * 1.6);
      expect(text.slice(original.length)).not.toContain(original.repeat(8));
    }
  }
  expect(overflowTexts('Hi')).toEqual(['Hi as noted', 'Hi as noted']);
  expect(editMatrix('')).toEqual([]);
});

test('kana takes precedence over Han and selects Japanese clauses rather than Chinese', () => {
  const chinese = '这份说明介绍了当前情况和需要调整的内容。';
  const japanese = 'この説明では現在の状況と必要な調整を確認します。';
  const katakana = 'カタカナ文章';
  const chineseSuffixes = overflowTexts(chinese).map(text => text.slice(chinese.length));
  for (const suffix of chineseSuffixes) {
    expect(suffix).toMatch(/^[\p{Script=Han}，。]+$/u);
  }
  for (const original of [japanese, katakana]) {
    for (const [i, text] of overflowTexts(original).entries()) {
      const suffix = text.slice(original.length);
      expect(suffix).toMatch(/[\p{Script=Hiragana}\p{Script=Katakana}]/u);
      expect(suffix).toMatch(/補足|調整|説明|確認/);
      expect(suffix).not.toBe(chineseSuffixes[i]);
      expect(suffix).not.toMatch(/\s/);
    }
  }
});

test('Hangul-only lines use Latin words without adding Han or Hangul glyphs', () => {
  const original = '현재 상황과 필요한 내용을 확인합니다';
  for (const text of overflowTexts(original)) {
    expect(text.slice(original.length)).toMatch(/^ [a-z]+(?: [a-z]+)+$/);
  }
});

test('sizing counts Unicode code points and every input produces stable nonidentity edits', () => {
  const digits = '1'.repeat(40), astralDigits = '𝟙'.repeat(40);
  expect(overflowTexts(digits).map(text => text.slice(digits.length))).toEqual(
    overflowTexts(astralDigits).map(text => text.slice(astralDigits.length)),
  );
  for (const original of ['', 'Hello world', '中文说明', '日本語の文章', '한글', astralDigits]) {
    expect(editMatrix(original)).toEqual(editMatrix(original));
    for (const edit of editMatrix(original)) expect(edit.text).not.toBe(original);
  }
});

test('unbreakable overflow preserves the old word replacement and three-character fallback spans', () => {
  expect(editMatrix('Hello world').find(e => e.kind === 'overflow-unbreakable')?.text).toBe('Hello'.repeat(8) + ' world');
  expect(editMatrix('! Hello world').find(e => e.kind === 'overflow-unbreakable')?.text).toBe('! ' + 'Hello'.repeat(8) + ' world');
  expect(editMatrix('中文说明').find(e => e.kind === 'overflow-unbreakable')?.text).toBe('中文说'.repeat(8) + '明');
});
