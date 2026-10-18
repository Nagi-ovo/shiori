# App.tsx → workspace layer

2026-09-23 · phases A–D done (2026-09-25) · status line per phase below.

## Why

`App.tsx` (~5.9K lines) has no owner for workspace state. Tabs, the active
tab, folder mounts and the active document's markers live in `useState`, each
mirrored by a `*Ref` so async flows can read the latest value (19 states,
26 refs). Every writer must keep both in sync, activation copies tab fields
into globals, and cold loading is triggered by an effect watching tab status.
The ordering bugs the deleted source-regex tests policed come from that
indirection. Extracting functions one at a time lowers the line count slowly
and leaves the ownership problem in place.

## Target

```
React (view only)
  App.tsx ── composition root: stores, ports, <WorkspaceView/>
  WorkspaceView ── one DocumentShell; the viewport switches on the active tab
        │ zustand selectors
        ▼
workspace layer (plain TS, unit-tested with fake ports)
  workspaceStore ── tabs, activeTabId, folderPaths, active-session markers,
                    open generation
  actions ───────── activate / close / reorder / pin / resident admission
  intake/ ───────── open pipeline (decide → load → finalize); pdf.js only
                    behind a PdfEngine port
  textSources/ ──── text write-back queue and timers
  merge/ ────────── page merge on top of pdfMergeOwnership
        │ injected ports
        ▼
src/platform · storage (drafts, runtimeSessions, workspace) · PdfEngine ·
toast/i18n
per document: tabStoreRegistry → one PdfEditorStore per tab (unchanged)
```

Rules for the layer:
- The workspace store is the only owner; `getState()` replaces every `*Ref`
  mirror.
- Components call actions; actions never import React.
- Tests drive actions against fake ports and assert resulting store state and
  port calls (AGENTS.md "Tests").
- `PdfEngine` is the seam where the Rust/PDFium core (native and WASM) later
  replaces pdf.js — see `docs/PLAN-RUST-PDF-CORE-2026-09.md`.

## Phases (each mergeable on its own)

**A — workspace store.** A1: `tabs`, `activeTabId`, `folderPaths` move to
`src/workspace/workspaceStore.ts`; the three ref mirrors go.
A2: the active-session markers (`activeHash`, export baseline, `lastExport`,
draft notices) move in as session fields; their ref mirrors go. They stay
separate from the tab record: today the globals are the live values and the
tab record is the persisted copy, synced on tab switch and on export. Making
the tab record write-through is a behaviour change, planned separately.
A3: activate and close become workspace functions with ports
(`src/workspace/tabLifecycle.ts`), applying `planTabActivation`. Retires:
stale-snapshot revival, close re-reading after flushes. Resident admission
cleanup lives in the open pipeline, so it moves to B; close serialisation
stays App wiring (`enqueueTabClose`). Phase A moves ownership, not bulk: it
ends near 5.8K lines; the bulk leaves with intake.

**B — intake.** `handleBytes`, `handleNonPdfDocument`, `finalizeOpen`,
`loadWorkspaceTab` → `src/workspace/intake/`, with pdf.js behind `PdfEngine`.
Open generation becomes a store API used only by intake;
`openGenerationContract` becomes a behaviour test. Activation calls cold
load explicitly instead of the status-watching effect. Retires: open
generation, Live receipt injection, resident admission cleanup.
Ratchet ≤ 4700.

**C — text sources and merge.** Text write-back → `src/workspace/textSources/`;
`runAppendIncomingPdf` → `src/workspace/merge/`. Markdown keystroke cost is
measured, not regex-checked. Retires: text write-back, merge ordering,
keystroke encoding. Ratchet ≤ 2800.

**D — one shell.** The four `DocumentShell` branches become `WorkspaceView`;
rail continuity across document kinds is then structural and testable by
rendering `WorkspaceView` over a fake store. Retires: rail remount. Ratchet
≤ 1000.

Gate for every phase: `bun run verify`; workspace-layer behaviour tests;
web smoke (four PDFs open, switch, suspended cold load, close through to
home; Markdown edit then close; draft restore; encrypted PDF; page merge);
`tauri:dev` for native open and the exit guard. IndexedDB and workspace
persistence formats do not change, so every phase rolls back as jj changes.

Not in scope: `lib.rs` / `cli/main.ts` splits, tile rendering, behaviour
changes, new dependencies (zustand is already used).

## Status

- A1 done (2026-09-23): tabs, activeTabId, folderPaths in `src/workspace/workspaceStore.ts`; App.tsx 5903 lines.
- A2 done (2026-09-23): active-session markers in the store as `session`; runtime tab and draft types in `src/workspace/types.ts`; App.tsx 5817 lines.
- A3 done (2026-09-23): `src/workspace/tabLifecycle.ts` with 13 behaviour tests; App.tsx 5776 lines. Phase A complete.
  Phase A was checked in the web build only; it moved platform-agnostic store
  logic. The native (tauri:dev) gate is deferred to phase B, where intake
  touches platform ports.
  The quick-double-click race (tabs resolving in finish order) was fixed in A
  by checking the open generation after the flushes (`isCurrent` port).
- B1 done (2026-09-23): the open generation and foreground intent are store
  claims (`claimOpen`, `claimNavigation`, `claimForegroundIntent`);
  `activateTab` and the new `goHome` flow claim inside the workspace layer,
  which also fixed the same finish-order race for the logo. The merge rule
  it protects is App wiring until merge moves in C, so `openGenerationContract`
  became an ESLint rule, not a behaviour test.
- B2 done (2026-09-23): `PdfEngine` (`src/pdf/engine/`) with a pdf.js
  implementation; opening and merging reach pdf.js only through it, and the
  document handle stays pdf.js's until rendering moves (Rust plan stage 3).
  `finalizeOpen` is `src/workspace/intake/finalizePdfOpen.ts`, tested against
  a real editor store (Live receipts kept across a merge). App.tsx 5543 lines.
- B3 done (2026-09-23): the open pipeline is `src/workspace/intake/`
  (`openPdf`, `openDocument`, draft recovery), driven through `IntakePorts`
  and tested with fake ports and a fake engine: a superseded open stays in
  the background, dedupe, password retry frame, resident-slot failure, a tab
  closed mid-restore, silent draft restore, parse failure, Markdown open,
  Word policy rejection. `updateTab`/`setActiveTab` are store actions.
  Removing the old non-PDF open ended a silent React Compiler bail-out on
  AppContent; the 10 diagnostics it had hidden came from phase A's
  `useWorkspace` local, now a module-level hook. App.tsx 4687 lines.
- B4 done (2026-09-23): cold load is `src/workspace/intake/coldLoad.ts`
  and `readTabSource.ts`. The effect that watched the active tab's status
  is gone: launch loads the saved active tab once, tab activation ends with
  a `loadDocument` step (switch, close, logo), and a superseded restore that
  is still on screen, or the admission Retry, loads again explicitly. Six
  behaviour tests plus two activation-plan tests. App.tsx 4524 lines.
  Phase B code is complete (target ≤ 4700 met). Native gate: `tauri:dev`
  boots and restores the saved PDF with no errors; the native picker,
  Finder "Open with" and the quit-with-draft guard were checked by hand
  on 2026-09-24, on the D2 build, with the browser rail kept across PDF,
  Markdown and Word switches.
- C1 done (2026-09-23): text write-back is `src/workspace/textSources/`
  (`createTextSources`: debounced working copy, flush, ⌘S write-back queue),
  with its reader-facing messages as typed notices that App translates.
  Keystroke cost is checked by counting encodes, not by timing: encoding
  25 MB of text ×20 took 64 ms on this Mac, too close to the equality check
  every edit needs for a time budget to tell them apart. App.tsx 4304 lines.
- C2 done (2026-09-23): page merge is `src/workspace/merge/pageMerge.ts`
  (`createPageMerges`, its own queue). The P1 that `openGenerationContract`
  guarded is now a behaviour test: a document opened while a merge waits
  keeps the screen. The ESLint rule moved with the merge, to
  `src/workspace/merge/**`. App.tsx 3990 lines.
  Phase C missed its ≤ 2800 target: what remains in App.tsx is mostly the
  four DocumentShell render branches and their props, which is phase D's
  work, so D's target (≤ 1000) carries the difference.
  That reading was wrong by about 2×: measured on 2026-09-24, AppContent's
  hooks and callbacks are ~2100 lines and the render branches ~980, so
  D (one shell) ends near 2900, not 1000. Reaching 1000 needs a further
  step that moves the pick/reopen/close flows and the ports assembly into
  hooks; whether to add it is open.
- D0 done (2026-09-24): the store singleton, `useWorkspace`, the session
  setters and the tab meta mapping are `src/workspace/appWorkspace.ts`.
  App.tsx 3912 lines.
- D1 done (2026-09-24): the viewports are components in `src/App/render/`
  (`PdfViewport`, `TextViewport`, `DocxViewport`, `DocumentLoadingState`);
  `TextViewport` subscribes to its own Markdown prefs, so App no longer
  re-renders on them. The four `DocumentShell` branches are unchanged.
  Web smoke: PDF, Markdown and Word open together, the `<main>` node is the
  same element across every kind switch, zoom and a Markdown edit survive
  reload. App.tsx 3568 lines.
- D2 done (2026-09-24): `src/App/render/WorkspaceView.tsx` renders the one
  `DocumentShell` for every document kind; App passes the shared chrome, the
  per-kind viewports and, for an open PDF, its own chrome. Rail continuity is
  a behaviour test (`WorkspaceView.test.tsx`: the rail is the same DOM node
  across PDF loading, Markdown, Word and an open PDF; red when the shell is
  keyed by kind), and `rootRenderSelectors` covers `WorkspaceView`. Landing,
  error and expired screens stay outside it. App.tsx 3439 lines.
- D3a done (2026-09-24): where documents come from is
  `src/workspace/acquire/` (`createDocumentAcquisition`): the picker on each
  platform, dropped and picked files, recents, and a restore-failed tab
  reading its file again. The platform is a port, so desktop and web routes
  run in one test file (seven behaviour tests, each red when the branch it
  guards is removed). App connects its live intake ports from effects
  (`src/App/acquisitionPorts.ts`); the `pickFileRef` and
  `reselectWorkspaceTabRef` bridges are gone. Web smoke: multi-file open in
  order, unsupported file, recent PDF and Markdown reopen. App.tsx 2966
  lines.
  What is left, measured: imports ~270, module helpers ~275, AppContent
  logic ~1650, render ~630. The next cuts and what each is worth:
  D3b tab session wiring (resident admission, persist, activation, close,
  go home, intake and cold-load ports; ~620 lines, about −450 net);
  render prelude, landing and error screens into components (~−350);
  draft decisions and the merge picker (~−200); module-level persisters
  (~−200). Together that is about 1500 lines. Reaching 1000 would also mean
  moving the native menu effect, which guards the exit handshake and has
  no test yet.
- D3b done (2026-09-24): the workspace runtime App owned through
  empty-dependency callbacks is plain modules: `src/App/workspaceStorage.ts`
  (workspace record, cache references, startup repair),
  `src/App/residentPdfs.ts` (suspending the least recent PDF, resident
  admission, tab previews, releasing a closed tab), `src/App/textRecents.ts`,
  `src/App/workspaceNotices.ts`, and the null-rendering persisters in
  `src/App/render/persisters.tsx`. No behaviour change; the modules are
  wiring, so they are covered by the web smoke only (six tabs past the
  resident limit, suspended tabs reload, close a background and the visible
  tab, a Markdown edit survives reload). Activation, close, go-home and the
  intake ports stay in App: they read React state. App.tsx 2411 lines.
- D3c done (2026-09-24): the tab strip, navigator and Ctrl+Tab lists and the
  tab hover preview are functions in `src/App/workspaceLists.ts` (three
  behaviour tests: switcher order, the background PDF marker, the text
  marker); the window's dialogs, the home screen and the hidden document
  picker are `src/App/render/WindowOverlays.tsx`. The home screen keeps its
  own dialog order: the dialogs are not portals, so their order is their
  stacking. Web smoke: home, shortcuts and changelog on home, three
  documents open, back home. App.tsx 2192 lines.
- D3d done (2026-09-24): what the reader decides about a saved draft
  (restore, discard, dismiss, open the original, the edit that raises the
  conflict) is `src/workspace/draftDecisions.ts`, tested against a real
  workspace store and editor store (six tests). Web smoke: silent restore,
  open the original, an edit raises the conflict, Restore and Discard from
  the dialog. App.tsx 2071 lines.
  The smoke found that dismissing the conflict after the edit that raised
  it re-raised it at once (the edit watcher counted the undo history that
  edit left); fixed separately, see the changelog.
- D3e done (2026-09-24): inserting a picked PDF's pages is
  `src/workspace/merge/mergePicker.ts` (five tests: placement, the file
  input inserting where the picker was opened for, one insert at a time,
  the delayed busy state, a non-PDF refused). Web smoke: Insert pages from
  PDF, 8 → 67 pages, undo available. App.tsx 1992 lines.
- D3f done (2026-09-25): the native menu is `src/App/nativeMenu.ts`, wired
  once through `src/App/nativeMenuPorts.ts`; App connects the update check
  and the exit completion from an effect and installs the menu with no other
  dependency, so tab switches and language changes never re-wire it. Three
  tests: the exit guard reports ready only after the exit channel is
  subscribed, a teardown mid-install leaves nothing subscribed and the guard
  off, an item acts on the document on screen when it fires. The menu path
  is desktop-only, so the wiring is covered by the tauri:dev checks alone
  (⌘Q with an unsaved edit, the Edit and View menu items in a text field and
  on the page, ⌘Q after a language switch). App.tsx 1850 lines.
- D3g done (2026-09-25): window state App held inline is five hooks in
  `src/App/hooks/`: `useChangelog` (opens only on a genuine upgrade, first run
  records the version silently; three tests), `useCanvasWarning`,
  `useEncryptedPdfWarning`, `useNativeExpiry` and `useRailLayout` (the
  navigator and right-rail toggles, the mobile snap-shut). The last four are
  verbatim moves covered by the web smoke only. App.tsx 1691 lines.
- D3h done (2026-09-25): the engine documents PDF tabs hold are
  `src/workspace/pdfRuntime.ts`: suspending the least recent resident,
  releasing a closed tab, and recording the PDF being left before a switch.
  It releases through the `PdfEngine` port; before, these paths called
  `pdfjsEngine` directly, the last lifecycle code outside the engine seam.
  That matters for the Rust core: a PDFium or WASM document owns native
  memory, so a missed release is a leak and a double release is an error.
  Eight tests pin it: a row is written before its document is released, a
  failed write keeps the document, a tab closed mid-suspension leaves no row,
  closing releases each document exactly once, a failed draft save blocks
  the switch, a switch made during the save is not recorded into the tab
  left. `src/App/pdfRuntimePorts.ts` wires the real engine and storage.
  App.tsx 1656 lines.
- D3i done (2026-09-25): the open pipeline's ports are
  `src/App/intakePorts.ts`, created once per window with the PDF open queue
  inside; App connects what it owns from an effect declared before every
  effect that can open a document. The ports are one stable object now, so
  the `coldLoadPortsRef` bridge tab activation used is gone, and `t` and the
  GPU pref are read at call time instead of rebuilding the ports. Wiring,
  covered by the web smoke only (reload restores the active tab, open a PDF,
  switch to a suspended tab, a Markdown tab). App.tsx 1488 lines.
- D3j done (2026-09-25): text sources and page merges are created by
  `src/App/textSourcePorts.ts` (with the ⌘S claim) and
  `src/App/pageMergePorts.ts`; `src/App/translate.ts` gives modules created
  once a `t` that reads the language when a message shows. Both are created
  once, so `useAppShortcuts` takes them as plain functions and the two ref
  bridges are gone (its tests updated to the new signature). Web smoke:
  pasting an image into a PDF, ⌘S claimed on a Markdown tab. App.tsx 1391
  lines.
- D3k done (2026-09-25): switching, closing and leaving tabs are carried out
  by `src/App/tabLifecyclePorts.ts` (the planner applier, the close queue,
  go home, reorder, pin, the password prompt's retry state), created once;
  App connects the pending password, the export status and the draft flush
  from an effect declared before the intake connect. The step order stays
  tested in `tabActivation.ts` and `src/workspace/tabLifecycle.ts`; the
  applier is wiring. Web smoke: switch to a suspended PDF, close a
  background and the visible tab, back to home. App.tsx 1182 lines.
- D3l done (2026-09-25): AppContent's render section is components in
  `src/App/render/`: `PdfSessionControllers` (the draft, export, set-aside
  and Live controllers, mounted once around every screen), `PasswordPrompt`,
  `AppScreen` (error, home or workspace, with the window's dialogs),
  `WorkspaceScreen` (chrome, viewports and the open PDF's chrome, handed to
  the one `WorkspaceView`), `WorkspaceNavigator` and `PdfOverlays`. Hooks
  whose effects must outlive a screen stay in AppContent, as does the Find
  auto-close effect; leaves read the store state only they render, so
  AppContent re-renders less. The
  moved JSX is wiring: web smoke covered four-plus PDFs with switching,
  suspended cold load and closing through to home; a Markdown edit then
  close and reopen from recents; draft restore, open the original, and the
  conflict prompt; an encrypted PDF (wrong then right password, cancel then
  Unlock after a reload); inserting pages from a PDF and pasting an image;
  reader mode on desktop and phone widths; the phone thumbnails drawer and
  outline rail; settings and shortcuts on the PDF and Markdown screens, and
  shortcuts (⌘/) on home, which has no settings button; the navigator shown
  and hidden on a PDF and a Markdown tab, with the document column's edge
  and width identical to `main` before the split; the navigator clamped to
  the narrower window after a resize. Not exercised on web: an export that
  finishes after a tab switch (the web export did not go through the faked
  save picker and finished first), so that stays in the tauri:dev list.
  App.tsx 452 lines.
- Native gate passed (2026-09-25, tauri:dev): native picker
  multi-select, Finder "Open with", recent PDF reopen, the ⌘Q draft guard,
  the menu bar edit items, resident suspension and resume, the encrypted
  resume, export attribution across a tab switch. Phase D is done.
