import {describe,expect,test} from 'bun:test';
import {breakLines,placeFlow} from './flowLayout';

// One unit per character keeps widths readable: "abc" is 3 wide.
const measure = (s: string) => [...s].length;

describe('breakLines', () => {
  test('wraps Latin text at spaces and drops the breaking space', () => {
    expect(breakLines('aa bb cc dd', [5, 5, 5], measure)).toEqual(['aa bb', 'cc dd']);
  });
  test('wraps CJK text between any two characters', () => {
    expect(breakLines('图书馆每周六上午开', [4, 4, 4], measure)).toEqual(['图书馆每', '周六上午', '开']);
  });
  test('never starts a CJK line with closing punctuation', () => {
    expect(breakLines('图书馆周，六开', [4, 4], measure)).toEqual(['图书馆', '周，六开']);
  });
  test('uses each line its own width (a narrower continuation frame)', () => {
    expect(breakLines('aa bb cc dd', [5, 2, 2], measure)).toEqual(['aa bb', 'cc', 'dd']);
  });
  test('returns null when a single word is wider than its line, never hyphenates', () => {
    expect(breakLines('abcdefgh', [5], measure)).toBeNull();
  });
  test('returns null when the lines run out', () => {
    expect(breakLines('aa bb cc dd ee', [5, 5], measure)).toBeNull();
  });
});

describe('placeFlow', () => {
  const f0 = { rect: { x: 0, y: 67, w: 100, h: 33 }, firstBaseline: 91, pitch: 10, size: 10, descentEm: .3 };
  const f1 = { rect: { x: 0, y: 0, w: 100, h: 60 }, firstBaseline: 51, size: 10, descentEm: .3, sourceBaselines: [51, 41] };
  test('keeps the story in the first frame when it fits and leaves the second frame alone', () => {
    const p = placeFlow(2, f0, f1);
    expect(p).toEqual({ ok: true, first: [91, 81], spilled: [], pushedBy: 0 });
  });
  test('continues at the second frame’s first baseline and pushes its text by whole lines', () => {
    const p = placeFlow(5, f0, f1);
    expect(p).toEqual({ ok: true, first: [91, 81, 71], spilled: [51, 41], pushedBy: 20 });
  });
  test('refuses when the pushed text would leave the second frame', () => {
    expect(placeFlow(9, f0, f1)).toEqual({ ok: false });
  });
  test('refuses when the story’s ink would rise above the second frame’s top', () => {
    // 51 + 1.0 em reaches 61, above the frame top at 60.
    expect(placeFlow(5, { ...f0, ascentEm: 1 }, f1)).toEqual({ ok: false });
    expect(placeFlow(5, { ...f0, ascentEm: .9 }, f1).ok).toBe(true);
  });
  test('refuses when the first line’s ink would rise above the first frame’s top', () => {
    // 91 + 1.0 em reaches 101, above the frame top at 100; a story that fits is still refused.
    expect(placeFlow(2, { ...f0, ascentEm: 1 }, f1)).toEqual({ ok: false });
  });
  test('refuses a spill when the second frame’s text is too large for the first frame’s pitch', () => {
    // Pushed by whole 10 pt lines, 12 pt text would sit 10 pt under the last spilled line.
    expect(placeFlow(5, f0, { ...f1, size: 12 })).toEqual({ ok: false });
    expect(placeFlow(2, f0, { ...f1, size: 12 }).ok).toBe(true);
  });
});
