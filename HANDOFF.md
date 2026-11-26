# Handoff

Current state and next steps only. History lives in `git log`, `CHANGELOG.md`
and `docs/POSTMORTEMS.md` — when an item here is done, delete it rather than
marking it done.

Last reconciled against reality: **2026-10-23**.

## Font selection for PDF text edits

PDF text edits reuse encodable source glyphs first. For a missing horizontal
cluster, the writer tries the resolver’s metric-compatible Latin face. If the
replacement exceeds its slot, only that slot retries with the bundled face
for the source’s generic font class. The whole edit must still fit.

Retypesetting compares both faces in scratch when their metrics can differ.
Even a narrower face can move a word onto another line or change whether the
next paragraph is pushed. The writer prefers the metric-compatible face when
the verified line assignments and fit decisions agree. Otherwise it keeps
the proved generic layout and installs only the selected font subsets.

In mixed CJK text, each missing Han glyph follows its source CID ordering,
then its source language. A nearby kana or Hangul word supplies context for
neutral glyphs. For Latin text, a recognized `/BaseFont` identifies the
family. Descriptor names can identify a bundled substitute when the declared
name is unrecognized. Local fonts still match against the declared name.

Identity-V needs a vertical advance and origin for each new glyph. A column
of digits alone therefore uses a face with vertical metrics, with CID
ordering, source language, then SC deciding the bundled region. Upright
cells positioned by the page can use the Latin face when it covers the
glyph. Both writers check vertical alternates on the face they install.

## Current state

- **App 26.10.23 (唯我独尊) is the live release**: the whole 2026-10-20
  audit batch (`docs/AUDIT-2026-10-20.md`, all 119 handled). macOS local
  signed + notarized, Windows/Linux/Android from CI; the live updater
  verifier passes on all four desktop platforms. Shipped without device
  checks and not announced, both by Jesse's choice. The GitHub release is
  not flagged latest (`gh release edit --latest` returned 422; the
  latest-release API answers 404). The oracle-arm Discord bot posted it to
  `shiori-zh` / `shiori-en`; that is the only announcement (no QQ).
- **CLI 0.1.27 is live** on curl, PowerShell and npm
  (`@nagi-ovo/shiori`, first time on npm). Its first archives crashed on
  every Mac (POSTMORTEMS 2026-10-23); nobody had installed them, so they
  were replaced in place from main (`b2067ab`), tag still on `c955880`.
  curl and npm installs verified on this Mac; Windows only through CI.
  Publishing to npm needs Jesse's `npm login` plus a browser 2FA.
- **Open source** since 2026-10-18: `Nagi-ovo/shiori` holds source,
  releases, tags and the updater's `gh-pages`. Cloudflare Pages:
  `shiori.nagi.fun` → `shiori-site`, `app.shiori.nagi.fun` → `shiori-web`
  (DNS in the separate Aliyun zone `shiori.nagi.fun`). The `release`
  environment holds every signing secret. The Discord bot
  (`discord-bot.service` on `oracle-arm`) watches `Nagi-ovo/shiori`.
- **B027 is closed** by refusing declarative shadow DOM in run mode,
  verified in Chromium only, not WebKit. A "fully trusted" run tier that
  re-enables it is deferred until a real file needs it.
- **Left as they are by Jesse's call:** B108 (no PDFium API up to
  chromium/8111) and B088 (wry gesture signals).
- **Open product question:** a signed PDF whose print copy needs a rebuild
  (overlays) is refused printing, though paper has no signature to break.
- **This Mac has no JDK / Android SDK**: Kotlin compiles only in CI.

## Next up

- **Linked text frames**: export pre-pass, dry
  run (`planLinkedFlow`), store actions, draft recovery, the export dialog,
  the editing preview and thumbnails carry chains. Open: new characters in
  a CID-keyed CFF program declared CIDFontType2 are refused, matching the
  coverage proof; stage 2 (cross-page, more than two frames) is unstarted.
  Unplaced shows (Type3, ExtGState-installed fonts) have their ink bounded
  before layout; overlapping ink refuses as an obstacle, unboundable ink as
  unsupported text, proven misses still flow. Flow tests: 54 pass.
  `fittedCorrection.native.test.ts` can crash Bun with EPERM in a sandboxed
  run; this also reproduces on the previous HEAD.

- **R3 semantic integration on R4 (`66bbc2f`).** Export and preview use
  the same preflight, cached font options and compiled semantic proofs.
  Font selection reads inline and named language with the same tokenizer
  that tracks replacement values and MCID byte spans. Retypeset fit trials
  keep glyph ownership, including retained suffixes in partial shows.
  Tagged Forms with unresolved ownership refuse before font preparation.
  Rootless whole-span stripping keeps R1's `stripped` manifest action and
  review finding. Strict export restores the source when that edit is refused.
  Linked flow keeps its source-font coverage policy and refuses Type3 ink
  intersecting the destination. A `d1` box alone does not clip paint.
  The image writer verifies marked paints and Form copies independently of
  text, and live OBJR annotations keep their identities through page copy.
  Four exports matched R4's font choices, line placement and extracted text
  with and without MCIDs. The marked edits retained their MCIDs. The
  optional Japanese TrueType test passed with native vertical placement.
  R1–R4 visible passed 8/8 each. Linked flow passed 11/12 with the known
  source-font coverage refusal. The build, changed-file lint and file-size
  checks passed. Full unit had zero new failures or errors against R4.
  Across 57 files and 2,049 edit cases, only the six Amendment A1 cases
  changed mode. Each refused the cross-span edit and returned the original
  PDF bytes. All other rows retained their modes and font choices. The
  corpus kept 655 exact nonvertical edits and 299 accepted vertical edits.
  Native checks matched the pinned 12/16 legacy and 16/16 corrected results.

- **Tagged PDF page operations.** Reordering, rotation and blank insertion
  keep the structure graph when every source page has one destination.
  Subset exports rebuild the forward items and ParentTree for live,
  unambiguous owners. The same layout policy applies with zero content edits.
  Projection keeps a bound link's OBJR and ParentTree slot when navigation
  leaves its copied annotation in the owning page's /Annots. Internal links
  can target a retained page with multiple exported copies. Structure
  bindings still require an unambiguous owning copy. Navigation-dropped
  link children alone leave the parent's replacement text intact, including
  when those children are nested under structure elements. Original only
  also preserves those labels for annotation OBJRs bound unambiguously on a
  retained page before any annotation removal. Projection omits
  ambiguous bindings, IDs, class and attribute data, and labels on branches
  that lose genuine content or an owning page. Content covered by an omitted
  binding still uses source preflight and refuses a write. Uncovered edits
  can install.
  Replacing a physical stream named by an MCR still requires proof
  of that edge, and the existing refusal applies when the writer coalesces it.
  Linked dry runs check the same rebuilt layout for page operations. Page
  previews keep the original document context because they receive one page.
  A tagged named replacement removes obsolete aliases from the edited page's
  private resources when every content part and resource scope rules out
  another use. Shared, nested and unproven uses keep their names.
  In 24 strict text exports across eight layouts, the output kept each
  edited page's MCID owner and installed the independent unmarked edits.
  Tagged image moves and linked flow also installed after blank insertion.
  For the link fix, 24 export checks covered direct and indirect
  destinations, named links, nested link children and link-only files.
  All full-document no-edit controls returned the original bytes. The
  build, changed-file lint and 334 focused tests passed. R1–R4 visible
  each passed 8/8. Linked flow passed 11/12 with its known font refusal.
  All 2,049 corpus outcomes and native verdicts matched `73d16bf`.
  The full unit run added no failures or errors.

0. **Device checks owed before the next app release** (`RELEASE-CHECKS.md`).
   Nothing since 26.9.8 has been walked on a device; Android first:
   - A0.13 (Android on the wasm engine, shipped in 26.10.20) is blocking;
     A0.11 (DOCX engine 2.21.1, CJK overrun) on a real phone;
   - macOS trackpad pinch on PDF, Word, text and HTML views (rotated page,
     pinch held over a second, ctrl+wheel after a pinch); reopen a PDF at
     fit-width on page 5 lands on that page's top; View > Zoom walks the
     toolbar steps; Ctrl+Tab switcher + Delete leaves the selected
     annotation alone;
   - encrypted PDFs (fixtures and passwords in
     `crates/shiori-core/tests/fixtures/encrypted/`): annotate, export,
     reopen with user and owner password, print, insert pages;
   - desktop after the lib.rs split: open/save dialogs, second-instance
     open, Markdown relative image, folder sidebar, Browser panel, terminal
     `open https://…`, menu + immersive mode, quit with unsaved edits;
     refused-copy export/discard on close/quit (unit-tested only).
1. **Windows walk-through of the window chrome** (msi from any release
   since 26.9.27): Ctrl+P / Ctrl+, / Ctrl+Z / Ctrl+= with the menu bar
   hidden; resize from every edge with shadow and rounded corners;
   maximized without clipping (tao can lose ~8px to the invisible frame);
   title-bar drag, double-click to maximize, Aero Snap; Restore after
   Win+Up; close with unsaved edits asks first; close with Settings or a
   dialog open; reader mode; dark mode hover colours; scrollbars; at 600px
   wide the hero scrollbar sits against the column divider; no menu bar
   attached. Snap Layouts on hovering maximize is known lost.
2. **Next app release:** `rustls-webpki` >= 0.103.16 (eMudhra intermediates
   blocklist) and rustls >= 0.23.45 (Dependabot); Dependabot also has glib
   (medium) and rand (low) open. Undecided: Node 26.12.1 for the CLI SEA
   (eMudhra fix; the CLI only talks loopback HTTP).
3. **Small known bugs:** the conflict toast reads "in another window.. Edits
   here" (double period); `src-tauri` clippy has 10 pre-existing errors.
4. **Rust PDF core leftovers** (`docs/PLAN-RUST-PDF-CORE-2026-09.md`): 3.6
   Windows IPC timing, A0.12 on Windows/Linux; 5.2 (native PDFium on
   Android) is performance only and needs an Android environment.
5. **Drop the old APK path a few months after 26.10.20:** builds from then
   on ask `/api/release?apkRepo=shiori`; the bare route still rewrites the
   APK URL to `shiori-releases` for 26.9.27 and older. Once those need not
   self-update, delete `legacyApkDownloadUrl` and `wantsLegacyApkPath` in
   `site/functions/_release.ts`.
6. **Housekeeping:** The old private repo `shiori-dev` stays
   private as is: it alone holds the pre-open-source history (~1428
   commits) and 3 open issues. The local web build's recents still hold
   B027 probe files.
7. Target-page-first open: on a 500-page synthetic PDF the prep chain (load
   + page info + annotation import) takes a median 154 ms; measure
   first-target-page time on a large real PDF before splitting it.
