import type { RunEdit, RunPlan } from './replaceRun';
import type { PdfRect } from '../../model/types';
export type PageRunPlan = Omit<RunPlan, 'edits'> & {
  edits: readonly (RunEdit & { editBox?: PdfRect })[];
};
// The page boundary owns edit-box geometry; the pure compiler receives only
// a distance in PDF points along the baseline. Preserve an even tighter cap.
export function pageRunPlan(plan: PageRunPlan): RunPlan {
  return { ...plan, edits: plan.edits.map(edit => edit.editBox ? {
    ...edit, availablePt: Math.min(edit.availablePt ?? Infinity, edit.editBox.w),
  } : edit) };
}
