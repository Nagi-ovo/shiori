import type { Overlay, PdfRect } from "../../pdf/model/types";
import type { ResizeCorner } from "./geometry";

export type DragState =
  | { kind: "none" }
  | {
      kind: "rect" | "highlight" | "stamp" | "note" | "text";
      startX: number;
      startY: number;
      curX: number;
      curY: number;
    }
  | {
      // Marquee (rubber-band) selection: user drags on empty page area
      // with the select tool. `additive` is true when Shift is held on
      // start — the marquee unions into the existing selection instead
      // of replacing it.
      kind: "marquee";
      startX: number;
      startY: number;
      curX: number;
      curY: number;
      additive: boolean;
    }
  | {
      // Plain (no-Shift) drag on empty page area with the select tool
      // pans the canvas by scrolling the Virtuoso scroller. Gives mouse
      // users a pan gesture (space-bar pan is keyboard-only). `moved`
      // distinguishes a real pan from a plain click — a click that never
      // moved is finalized as an empty-area deselect.
      kind: "pan";
      pointerId: number;
      startX: number;
      startY: number;
      scrollLeft: number;
      scrollTop: number;
      moved: boolean;
    }
  | {
      kind: "signature";
      startX: number;
      startY: number;
      curX: number;
      curY: number;
    }
  | { kind: "ink"; points: Array<{ x: number; y: number }> }
  | {
      kind: "move";
      // The pointer that owns this gesture. onPointerMove ignores every other
      // pointer id, so a second finger landing mid-drag cannot steer it.
      pointerId?: number;
      ids: string[];
      origin: { x: number; y: number };
      startOverlays: Overlay[];
      duplicateOnDrag?: boolean;
      // Set when this move began as a touch tap on an already-selected,
      // editable text/note overlay. If the gesture finalizes without moving,
      // finalizeDrag enters edit mode — the touch equivalent of the desktop
      // double-click, which is unreliable on a touchscreen. Holds the
      // overlay id to edit; absent for mouse drags and first-tap selects.
      tapEditCandidate?: string;
    }
  | {
      kind: "resize";
      pointerId?: number;
      id: string;
      corner: ResizeCorner;
      origin: { x: number; y: number };
      startRect: PdfRect;
      startOverlay: Overlay;
    }
  | {
      // Free-rotation drag on the rotation handle. The box center is
      // rotation-invariant, so we capture it in CLIENT coords once and
      // compute the pointer's polar angle around it each move.
      kind: "rotate";
      pointerId?: number;
      id: string;
      centerClientX: number;
      centerClientY: number;
      startPointerDeg: number;
      startAngle: number;
    };
