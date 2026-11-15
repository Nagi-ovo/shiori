import type { RunEdit, RunPlan } from './replaceRun';
import type { PdfRect } from '../../model/types';
import type {ReflowRecipe} from '../contentText/reflowTypes';
import {RunCompileError} from './runRefusal';
export type PageRunPlan = Omit<RunPlan, 'edits'> & {
  edits: readonly (RunEdit & { editBox?: PdfRect })[];
  /** Additive owned-tail recipe. Consume with compileReflowPlan; the fixed
   * compiler cannot reinterpret these verification-only deletion edits. */
  reflow?: ReflowRecipe;
  reflows?: readonly ReflowRecipe[];
};
// The page boundary owns edit-box geometry; the pure compiler receives only
// a distance in PDF points along the baseline. Preserve an even tighter cap.
export function pageRunPlan(plan: PageRunPlan): RunPlan {
  if(plan.reflow||plan.reflows?.length)throw new RunCompileError('reflow-required: owned-tail recipe requires compileReflowPlan');
  return { ...plan, edits: plan.edits.map(edit => edit.editBox ? {
    ...edit, availablePt: Math.min(edit.availablePt ?? Infinity, edit.editBox.w),
  } : edit) };
}
