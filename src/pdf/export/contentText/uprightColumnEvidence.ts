import type { GlyphPlacement } from '../contentStreamEdit/textState';
import type { ContentTextOutcome } from './outcomes';
import type { ColumnAtom } from './uprightColumnEmit';
import { address } from './retypesetSource';
import type { RetypesetGlyph } from './retypesetTypes';

export type ColumnCellEdit = {
  source: GlyphPlacement;
  text: string;
  selected: boolean;
  output: { font: string; code: number; x: number; y: number; text: string; wrapper: boolean }[];
};

export const columnEvidence = new WeakMap<ContentTextOutcome, readonly ColumnCellEdit[]>();

export function columnCellEdits(
  owned: RetypesetGlyph[], moving: RetypesetGlyph[], atoms: ColumnAtom[], equivalents: ReadonlySet<string>,
): ColumnCellEdit[] {
  const selected = new Set(owned);
  const groups = new Map<string, ColumnCellEdit>([...owned, ...moving].map(g => [
    address(g.glyph), { source: g.glyph, selected: selected.has(g), text: '', output: [] },
  ]));
  for (const atom of atoms) {
    const key = address((atom.anchor ?? atom.home).glyph);
    const edit: ColumnCellEdit | undefined = groups.get(key);
    if (!edit) continue;
    edit.text += atom.text;
    edit.output.push({
      font: atom.font.resourceName, code: atom.code, text: atom.text, ...atom.origin,
      wrapper: !equivalents.has(key) && atom.font.unicodeByCode.get(atom.code) !== atom.text,
    });
  }
  return [...groups.values()];
}
