# Canvas → viewport layer

2026-10-06 · all five phases landed (2026-10) · status line per phase below.

## Why

`src/editor/components/Canvas.tsx` (~2100 lines) took about 30 fix commits
in the 90 days to 2026-10-05. Fifteen were react-virtuoso remount and
zoom-commit bugs that 88ff0d70 removed structurally (`pdfPageLayout.ts`: the
page column is arithmetic on known page boxes). The bug classes still alive:

- **Print wiring** (8f4b32a6, 38c5b408, d9ebd489, 57490564, 01b6b858): the
  request lives in the app store as `isPrinting`, the work in a Canvas effect
  watching that flag, and RightRail reads the same flag to hide the native
  browser panel. Every rule added to print (permissions, signed and
  encrypted sources, lost characters) went into an effect nothing tests.
- **Gesture-stream classification** (34751f67, 171cfde2, 7c2644c9,
  aa9ed9bf, 0a1933dc, cec73fea; five also patched DocxViewer): "which
  stream is driving", the 250/140/900 ms settles, the pinch watchdog and
  double tap are written three times, in Canvas, DocxViewer and
  `useScrollableZoomGestures`.
- **Keyboard and zoom commands** (6df54a9b, e625e433, b736a151): Canvas and
  the native menu step ±0.1; ZoomControls and ContextualToolbar walk two
  different `ZOOM_STEPS` ladders.
- **Resize / fit chain** (b3993b62, 553be1ef, 80e5a20f; dormant): the fit
  scale is derived in two effects and one ref, a shrink is detected with a
  "last width" ref, and `chromeResizing` releases the parked size from an
  effect.

What they share is ownership by indirection: refs mirroring state
(`layoutRef`, `rangeRef`, `virtualizationRef`, `visualScaleRef`,
`fitWidthScaleRef` written by an effect); refs as change detectors
(`lastFitWidthRef`, `lastActivePageEffectRef`, `lastPagesKeyRef`);
`gestureZoomingRef` duplicating "a preview session exists"; effects used as
event triggers (`isPrinting`, `pageJump` as a command in state, the
`activePageId` effect that turns a state change into a smooth scroll,
`commitScrollTargetRef`); and split writers (`activePageId` is written from
seven places, and writing it scrolls as a side effect; `scrollTop` is also
written by OverlayLayer through `ScrollerContext`).

## Target

```
React (view only)
  Canvas.tsx ── page column JSX, binds DOM events to the modules below
        │ calls / ports
        ▼
src/editor/viewport/ (plain TS, unit-tested with fake ports and a fake clock)
  printPdf.ts ─────────── runPrint(ports) → PrintOutcome; requestPrint()
  zoomGestureStream.ts ── normalized input → preview(target, anchor) /
                          commit / cancel; settles, watchdog, double tap
  pageTracker.ts ──────── active page from page overlaps; the
                          programmatic-scroll gate; goToPage
  canvasKeymap.ts ─────── key event → command (pure)
  zoomCommands.ts ─────── the one zoom ladder and limits
  viewportController.ts ─ resize, fit, layout landing, zoom commit through
                          Scroller / PageRects / PreviewLayers ports
        │ injected ports
        ▼
store (`scale` single owner, `activePageId` observed state) · appPdfEngine ·
export · toast/i18n · Clock
```

Rules for the layer:
- Modules never import React; Canvas creates them once and binds ports.
- The store's `scale` stays the only owner of the committed zoom; the
  controller holds only the transient visual scale of a live preview.
- Commit anchors are page id + offset in PDF user space through
  `src/pdf/geometry/coords.ts` (AGENTS.md fact 1).
- Timers go through a Clock port; tests use a fake clock and assert no
  wall-clock timing.
- Tests drive the modules against fake ports and fake geometry (happy-dom
  does no layout); Canvas keeps its harness in `Canvas.pageColumn.test.tsx`
  for the view-level properties.

## Phases (each mergeable on its own)

**1 — print.** `src/editor/viewport/printPdf.ts`: `runPrint(ports)` with
ports for engine security, a lazy export, confirm, toast + `t`, and the
frame host. A `requestPrint()` action replaces the flag-plus-effect;
`isPrinting` stays only as the busy indicator RightRail reads. Behaviour fix,
its own change, started red: an encrypted PDF with any annotation or
attachment could never be printed (print omits document files, so it never
took the unchanged fast path, and the rebuild refused the encrypted source
with "printing your changes…" even with no edits). When the opening
password permits printing, print rebuilds from the engine's plaintext in
memory and hands it only to the print frame, revoked after print; never
written, cached or re-encrypted. Refusals say what actually stops them.

**2 — gesture stream.** `src/editor/viewport/zoomGestureStream.ts`: a pure
reducer from normalized events (ctrl+wheel, WebKit gesture bracket, touch
pinch, tap) to preview / commit / cancel, owning the driving stream, the
settles, the 3 s watchdog and double-tap detection. Adopted in Canvas,
then DocxViewer, then `useScrollableZoomGestures`, one commit each. The
gesture flag stays out of React state and zustand (2026-04-26), preview
frames stay synchronous with no rAF batching (2026-08-08).

**3 — navigation intent.** `src/editor/viewport/pageTracker.ts`: the
active page derives from page overlaps (PageRects port); the tracker owns
the programmatic-scroll-in-flight gate; navigation goes only through
`goToPage`, and `activePageId` becomes observed state. Thumbnails,
GoToPageDialog, RightRail and page merge move to `goToPage`. Starts red on
the suspected pointerdown-on-a-partly-visible-page jump, if it reproduces.
No time windows to tell who scrolled.

**4 — keymap and zoom commands.** `canvasKeymap.ts` (pure key resolver)
and `zoomCommands.ts` (one ladder and limits for keyboard, native menu,
ZoomControls, ContextualToolbar). The ZoomControls ladder is canonical; the
±0.1 steps go, noted in the commit as a behaviour change.

**5 — viewport controller.** `viewportController.ts`: resize, fit and
layout landing and the zoom commit through Scroller / PageRects /
PreviewLayers ports. Tests: rotated-page anchors, fit shrinks only, sizes
parked during a pane drag, restore surviving the first fit. Perf gate:
`scripts/perf/zoom-raster-probe.js` before and after, and the commit lands
within one frame; a regression blocks the seal.

Gate for every phase: `bun run verify`; module behaviour tests written from
a failure list before the module; an E2E run with its artifact under
`test-artifacts/<scenario>/` and the exact steps beside it.

## What not to do

- Reintroduce a measuring virtual list (2026-09-07).
- Add a second owner for `scale`.
- Gate `syncRange` on any flag (2026-09-08: blank document on Android).
- Put the gesture flag in React state or zustand, or batch preview frames
  with rAF.
- Tell programmatic from user scrolling with time windows (2026-08-08).
- Split JSX just to cut lines; line count is not the goal, ownership is.
- Add source-regex tests.
- Bundle a behaviour change into a refactor commit: behaviour fixes are
  their own change, started red.

## Status

All five phases landed (2026-10); each behaviour fix was its own change,
started red, with its E2E run kept under `test-artifacts/` locally. Still open:

- A signed PDF that needs a rebuilt print copy is still refused printing.
- The HTML iframe's pointer pinch still settles like a bracket (140 ms after
  lift); Canvas bases a bracket on the committed scale, Word and text on the
  visual one.
- A reader scrolling against a jump in flight is unit-tested only.
- The column still fits once to an assumed 800 px width before it is
  measured (a wasted raster at the wrong scale, no longer visible as a jump).
- Hand checks: a real macOS trackpad pinch, an Android pinch, and the desktop
  View > Zoom menu items.
