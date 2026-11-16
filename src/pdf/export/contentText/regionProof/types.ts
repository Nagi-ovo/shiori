import type { ContentOp } from '../../contentStreamEdit/tokenizer';
import type {PageOccupancy} from './occupancy';

export type Rect = { x: number; y: number; w: number; h: number };
export type SourceAddress = {
  streamHash: string; opIndex: number; itemIndex: number;
  byteStart: number; byteEnd: number; fontObject: string;
};
/** JSON array of [BMC/BDC operator, decoded tag name] pairs; excludes MCIDs.
 * The empty stack is "[]", distinct from every marked-content scope. */
export type ScopeKey = string;
/** Full state, supplied by a revision-bound R1 walker (not ShowTextState). */
export type TextTrace = {
  bt: number; opIndex: number;
  ctm: readonly number[]; tm: readonly number[]; tlm: readonly number[];
  fontObject: string; size: number; tc: number; tw: number; tz: number;
  leading: number; rise: number; renderMode: number; safetyHash: string;
  /** Missing keys on external evidence mean the unmarked scope only. */
  scopeKey?: ScopeKey; mcids?: readonly number[]; scopeSafe?: boolean;
};
export type ParagraphShow = {
  source: SourceAddress; unicode: string; before: TextTrace; after: TextTrace;
};
export type ParagraphLine = {
  /** State immediately AFTER the explicit Tm/Td/TD/T* anchor. */
  anchor: TextTrace;
  /** Physical baseline of the target member style; prefix Ts can differ. */
  baseline?: number;
  /** An excluded source placement is a boundary, never a line to skip. */
  sourceGapBefore?: boolean;
  /** Further explicit anchors on the same baseline (including sibling BTs).
   * Every anchor remains owned and checked against the source grammar. */
  continuations?: TextTrace[];
  /** Complete source string items in source order, with per-item snapshots. */
  shows: ParagraphShow[];
  /** Conservative ink, never coreQuad; null only for an explicitly blank slot. */
  ink: Rect | null;
};
export type SceneObstacle = {
  kind: 'text' | 'annotation' | 'paint' | 'stationary-backdrop';
  box: Rect | null; proofHash?: string;
};
/** R1/R2 evidence is mandatory: geometry alone cannot disprove a table/caption.
 * Hashes bind the caller's complete scene, source-code round trip and semantic
 * analysis to this immutable source/dependency revision. They are not guesses.
 */
export type ParagraphEvidence = {
  sourceHash: string; dependencyHash: string;
  obstacleProofHash: string; boundaryProofHash: string; scopeProofHash: string;
  completeScene: boolean;
  readingOrder: 'proven' | 'ambiguous'; whitespace: 'source-codes' | 'inferred';
  structure: 'body-text' | 'table' | 'caption' | 'labels' | 'unknown';
  columnBoundary: 'proven' | 'uncertain';
  semantics: 'plain' | 'redistribution-proven' | 'unresolved';
  inlineFeatures: 'plain-prose' | 'math-or-superscript' | 'unknown';
  crop: Rect; clip: Rect; obstacles: SceneObstacle[];
};
export type ParagraphInput = {
  sourceHash: string; dependencyHash: string; ops: ContentOp[];
  lines: ParagraphLine[]; evidence: ParagraphEvidence; rasterGuardPt?: number;
  /** Production defers scene/membership checks to the solved move set. */
  occupancy?: PageOccupancy;
  visualGroup?: VisualGroup;
};
export type VisualGroup = {
  start: number; end: number; lines: readonly ParagraphLine[];
  style: TextTrace; pitchPt: number; capacityRight: number;
  left: number; firstLeft: number; indent: ParagraphIndent;
  column: {x0:number;x1:number};
};
export type ParagraphIndent = {
  kind: 'flush' | 'first-line' | 'hanging';
  /** Nonnegative physical displacement; kind supplies the direction. */
  amountPt: number;
  /** Diagnostic only, within min(0.5 pt, 0.05 em) of 1/2 em. */
  emMultiple?: 1 | 2;
};
export type LineSlot = {
  baseline: number; left: number; right: number;
  kind: 'observed' | 'explicit-blank';
};
export type TjBoundary = {
  opIndex: number; itemIndex: number; value: number;
  left: SourceAddress | null; right: SourceAddress | null;
};
export type RegionProof = {
  sourceHash: string; dependencyHash: string; bt: number;
  kind: 'paragraph' | 'explicit-line-region'; box: Rect;
  /** Fixed before compilation. box is only this mask's union bound. */
  mask?: readonly Rect[]; occupancyHash?: string;
  /** All owned original ink, guard-dilated; oracle veto evidence only. */
  oldInk?: readonly Rect[];
  indent: Readonly<ParagraphIndent>; leadingPt: number;
  lineSlots: readonly Readonly<LineSlot>[];
  owned: readonly Readonly<SourceAddress>[];
  obstacleProofHash: string; boundaryProofHash: string; scopeProofHash: string;
  /** Ordered source TJ numbers; a proof never makes a kern splittable. */
  tjBoundaries: readonly Readonly<TjBoundary>[];
};
export type LayoutPolicy =
  | { mode: 'fixed-neighbours' }
  | { mode: 'spacing-only' }
  | { mode: 'bounded-reflow'; proof: RegionProof; maxWrapLines: number };
export type GlyphIdentity =
  | { kind: 'gid'; programHash: string; gid: number }
  | { kind: 'type1-name'; programHash: string; name: string }
  | { kind: 'type3-name'; fontHash: string; procHash: string; name: string }
  | { kind: 'standard14'; face: string; name: string };
export type MovedGlyph = {
  source: SourceAddress; code: Uint8Array; unicode: string;
  oldOrigin: readonly [number, number]; newOrigin: readonly [number, number];
  glyph: GlyphIdentity; ink: Rect;
};
export type SpacingRecipe = {
  tcDelta: number; twDelta: number; fontObject: string;
  source: readonly SourceAddress[];
  gaps: readonly { left: SourceAddress; right: SourceAddress; savedAdvancePt: number }[];
};
export type ReflowManifest = {
  region: RegionProof; moved: readonly MovedGlyph[];
  replacementText: string; visualLines: readonly string[]; expectedLogicalText: string;
  spacingRecipes: readonly SpacingRecipe[]; rejoin: TextTrace;
};
export type ParagraphBlocker = 'lines' | 'revision' | 'boundary' | 'semantics' |
  'direction' | 'operators' | 'ownership' | 'state' | 'leading' | 'edges' | 'bounds' | 'obstacles';
export type ParagraphRefusal = {
  ok: false; code: 'reflow-paragraph-unproven'; family: 'reflow-required';
  reason: 'No proven paragraph box for wrapping'; blocker: ParagraphBlocker; detail: string;
};
export type ParagraphResult = { ok: true; proof: RegionProof } | ParagraphRefusal;
