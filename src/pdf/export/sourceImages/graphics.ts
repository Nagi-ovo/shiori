import { composeFormMatrix } from "../contentText/retypesetForms";
import { simpleClipShape, type ImageClip } from "./clipShape";
import type { ContentOp } from "../contentStreamEdit/tokenizer";
import type { SourceImageMatrix, SourceImageStreamOwner } from "./content";

import type { PDFDict, PDFObject, PDFRawStream } from "pdf-lib";
import type { SourceImageResources } from "./objects";

export type IndirectImageContext = "tiling pattern" | "Type 3 glyph" | "annotation appearance" | "soft-mask group";
export type IndirectPaint = {
  context: IndirectImageContext;
  stream: PDFRawStream;
  entry: PDFObject;
  resources: SourceImageResources;
};

export type SourceClip = ImageClip & {
  parent?: SourceClip;
  removal?: { owner: SourceImageStreamOwner; op: ContentOp };
  firstPaint: number;
  endPaint?: number;
};

export type ImageClipState = { pathClips?: SourceClip; opaqueClip?: boolean };

export type Graphics = ImageClipState & {
  matrix: SourceImageMatrix;
  textMode: number;
  fillPattern?: IndirectPaint;
  strokePattern?: IndirectPaint;
  type3Font?: PDFDict;
  softMask?: IndirectPaint;
};
export type Frame<Path> = {
  owner: SourceImageStreamOwner;
  ops: ContentOp[];
  next: number;
  path?: Path;
  toPage: SourceImageMatrix;
  state: Graphics;
  stack: Graphics[];
  inText: boolean;
  pathStart?: number;
  pendingClip: boolean;
  pendingTextClip: boolean;
  marked: number;
  compatibility: number;
};

const pathEnd = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);
const pathBuild = new Set(["m", "l", "c", "v", "y", "h", "re"]);
export const textShow = new Set(["Tj", "TJ", "'", '"']);
export const fillPath = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);
export const strokePath = new Set(["S", "s", "B", "B*", "b", "b*"]);

export function compose(outer: SourceImageMatrix, local: SourceImageMatrix): SourceImageMatrix {
  const result = composeFormMatrix(outer, local) as SourceImageMatrix;
  if (!result.every(Number.isFinite)) throw Error("non-finite image transform");
  return result;
}

function noOperands(op: ContentOp): void {
  if (op.operands.length) throw Error(`invalid ${op.operator} operands`);
}

// Paint ordinals run through called Forms. A clip is exclusive only when
// the interval between its installation and restore contains one paint.
export function closePathClips(clip: SourceClip | undefined, previous: SourceClip | undefined, paints: number) {
  for (; clip && clip !== previous; clip = clip.parent) clip.endPaint = paints;
}

export function updateGraphics(frame: Frame<unknown>, op: ContentOp, paints: number): void {
  const { operator, operands } = op;
  switch (operator) {
    case "q":
      noOperands(op);
      frame.stack.push(frame.state);
      break;
    case "Q": {
      noOperands(op);
      const previous = frame.stack.pop();
      if (!previous) throw Error("graphics state stack underflow");
      closePathClips(frame.state.pathClips, previous.pathClips, paints);
      frame.state = previous;
      break;
    }
    case "cm": {
      if (operands.length !== 6 || !operands.every(operand => operand.kind === "number")) {
        throw Error("invalid cm operands");
      }
      const local = operands.map(operand => operand.value) as SourceImageMatrix;
      frame.state = { ...frame.state, matrix: compose(frame.state.matrix, local) };
      break;
    }
    case "BT":
      noOperands(op);
      if (frame.inText) throw Error("nested text objects");
      frame.inText = true;
      break;
    case "ET":
      noOperands(op);
      if (!frame.inText) throw Error("unbalanced text object");
      frame.inText = false;
      if (frame.pendingTextClip) frame.state = { ...frame.state, opaqueClip: true };
      frame.pendingTextClip = false;
      break;
    case "Tr": {
      const mode = operands[0];
      if (operands.length !== 1 || mode?.kind !== "number" || !Number.isInteger(mode.value) ||
        mode.value < 0 || mode.value > 7) throw Error("invalid text render mode");
      frame.state = { ...frame.state, textMode: mode.value };
      break;
    }
    case "W": case "W*":
      noOperands(op);
      frame.pendingClip = true;
      break;
    case "BMC": case "BDC": frame.marked += 1; break;
    case "EMC":
      noOperands(op);
      if (--frame.marked < 0) throw Error("unbalanced marked content");
      break;
    case "BX":
      noOperands(op);
      frame.compatibility += 1;
      break;
    case "EX":
      noOperands(op);
      if (--frame.compatibility < 0) throw Error("unbalanced compatibility section");
      break;
    default:
      if (pathBuild.has(operator)) frame.pathStart ??= frame.next - 1;
      if (pathEnd.has(operator)) {
        if (frame.pendingClip) installClip(frame, op, paints);
        frame.pathStart = undefined;
        frame.pendingClip = false;
      }
      if (frame.inText && frame.state.textMode >= 4 && textShow.has(operator)) frame.pendingTextClip = true;
  }
}

function installClip(frame: Frame<unknown>, terminator: ContentOp, paints: number) {
  const end = frame.next - 2;
  const op = frame.ops[end];
  const shape = frame.pathStart !== undefined && (op?.operator === "W" || op?.operator === "W*")
    ? simpleClipShape(frame.ops, frame.pathStart, end) : undefined;
  if (!shape) {
    frame.state = { ...frame.state, opaqueClip: true };
    return;
  }
  const matrix = compose(frame.toPage, frame.state.matrix);
  // Leave the path and its terminator in place. Only a single rectangle
  // discarded without painting can have its clipping operator removed.
  const removal = "box" in shape && terminator.operator === "n" && !terminator.operands.length
    ? { owner: frame.owner, op: op! } : undefined;
  const pathClips = { ...shape, matrix, parent: frame.state.pathClips, firstPaint: paints, removal };
  frame.state = { ...frame.state, pathClips };
}
