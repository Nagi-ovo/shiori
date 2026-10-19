# Handoff

Current state and next steps only. History lives in `jj log`, `CHANGELOG.md`
and `docs/POSTMORTEMS.md` — when an item here is done, delete it rather than
marking it done.

Last reconciled against reality: **2026-10-17**.

## Current state

- **Shiori is open source** (2026-10-18). `Nagi-ovo/shiori` is the public
  source repo (formerly `shiori-releases`; releases, tags and the updater's
  `gh-pages` live there too). The old private source repo is `shiori-dev`,
  Actions off, to be archived. Cloudflare Pages deploys from the public repo
  since 2026-10-19: `shiori.nagi.fun` → project `shiori-site`,
  `app.shiori.nagi.fun` → `shiori-web` (DNS: the `@` and `app` CNAMEs in the
  separate Aliyun zone `shiori.nagi.fun`, not the `shiori` record in
  `nagi.fun`). The old projects `shiori-promotion` / `shiori-app` stay for
  rollback until Jesse deletes them. Still open: archive `shiori-dev`, and the
  `release` environment lacks the Apple and macOS certificate secrets.

- **The encryption, Canvas, tab strip and lib.rs work is on `main`, not in
  a release yet** (58 changes sealed 2026-10-07, rebased onto `a48fb9de` and
  pushed 2026-10-17; the web version deploys from `main`, so it already
  runs them). Gates after the rebase: `bun run verify` 1979 pass,
  `test:core` green; `tauri build` green before the rebase. Three tracks, each
  Codex-reviewed, plus two tab-strip fixes:
  - *Encrypted PDFs keep their encryption:* annotate/export re-encrypts with
    the source's own /Encrypt, key and /ID[0] (user and owner passwords both
    still work); permissions (print, modify, annotate, assemble) are honored;
    unknown security fails closed; page insertion into an encrypted base
    keeps its encryption; printing goes through the engine's plaintext,
    which reaches only the hidden print frame. Web E2E in
    `test-artifacts/encrypted-pdf-export/`.
  - *`src-tauri/src/lib.rs` split* from ~5900 lines to 563 across domain
    modules (`docs/PLAN-TAURI-MODULES-2026-10.md`); `bindings.ts` and the
    ACL manifest byte-identical. Windows/Linux only type-checked, Android/iOS
    not built.
  - *Canvas viewport layer* (`docs/PLAN-CANVAS-VIEWPORT-2026-10.md`, all 5
    phases): print, zoom gesture stream, page tracker, keymap, viewport
    controller under `src/editor/viewport/`; fixes a lost pinch commit, a
    press-scrolls-to-top jump and a 474 px reopen offset. Artifacts in
    `test-artifacts/{viewport-controller,zoom-gestures,navigation,print}/`.
  - *Tab strip drag:* a dragged tab stays on the strip's axis and inside it,
    and moves as a whole tab instead of a stretched, faded label
    (`test-artifacts/tab-strip-drag/`, web only; three-finger drag in the
    macOS app still to check by hand).
- **Open product question:** a signed PDF whose print copy needs a rebuild
  (overlays) is refused printing, though paper has no signature to break.

- **App 26.9.27 (赤毛异人) is the live release** (2026-09-27): macOS,
  Windows, Linux, Android direct APK; `alpha/latest.json` points at it and
  the live verifier passes on all four desktop platforms. Ships the Windows
  in-app title bar, hidden Windows menu bar, thin Windows/Linux scrollbars,
  closable toasts and the moved-file message. Released without device checks
  (A0.13 included). Epigraph pool: 5 of 20 used.
- **Shipped in 26.9.27, from a Windows tester's screenshot:** toasts get a
  real close button (the error X was a decorative glyph); a moved/deleted
  file reads as such instead of "(os error 3)"; thin scrollbars on
  Windows/Linux; the Windows menu bar hidden; Windows drawn undecorated with
  in-app caption buttons (`WindowCaption.tsx`). Everything past the toast
  and the error copy is **unverified on Windows** — see Next up 1. Linux
  keeps its native title bar and menu bar on purpose (GTK drops accelerators
  of a hidden menu).
- **Device checks are the release gap.** 26.9.8 shipped with zero device
  checks and broke twice on real phones; nothing records whether 26.9.9 was
  walked through `RELEASE-CHECKS.md` A0.8–A0.11 (Android edge-to-edge, Word
  single-finger scroll, PDF touch, DOCX engine 2.15.1). This Mac has no JDK /
  Android SDK — Kotlin compiles only in CI.
- **CLI `cli-v0.1.25` is public** (2026-09-13), on its own `cli-v*` tag
  namespace. Install: `curl -fsSL https://shiori.nagi.fun/cli | sh`,
  `irm https://shiori.nagi.fun/cli.ps1 | iex`, or the npm fetcher
  `npm install -g @nagi-ovo/shiori` (fetches the same archive; it is not the
  source). All three live routes verified 2026-09-23. Targets: darwin-arm64,
  linux x64/arm64 (glibc), win32 x64/arm64 — no darwin-x64 (upstream Node SEA
  bug, POSTMORTEMS 2026-08-17). The 0.1.25 macOS binary is ad-hoc signed;
  Developer ID signing (`1d0cf953`) lands with the next `cli-v` tag.
  From the next `cli-v` tag the CLI reads and renders only through
  `native/` (shiori-core addon + PDFium, ~9 MB); pdf.js and the canvas
  runtime are gone (unreleased, 2026-10-19). darwin-arm64 is now 54 MB
  compressed, 131 MB unpacked (was 68 / 156 MB). Error codes changed:
  `ERR_RENDER_UNAVAILABLE` is gone; a missing addon is
  `ERR_PDF_ENGINE_UNAVAILABLE`, unreadable annotations
  `ERR_ANNOTATIONS_UNAVAILABLE`. Its Linux/Windows builds have run only in
  CI, so check `cli-verify` after the push.
- **PDFium is the app's only PDF engine** (unreleased,
  `docs/PLAN-RUST-PDF-CORE-2026-09.md`): desktop uses the native core,
  web and Android the wasm core in a Worker; pdf.js is gone from the repo
  (2026-10-19).
  **Android now runs on the wasm engine unverified on a device — the
  largest release risk; RELEASE-CHECKS A0.13 must pass before an Android
  release.** The local desktop bundle was rebuilt and Developer ID signed
  on 2026-09-25 (not notarized; releases still go through
  `./scripts/build-signed.sh`).
- **DOCX engine bumped to 2.21.1** (unreleased), which fixes the CJK overrun
  from upstream #787; verified in the web build only. A0.11 on a real phone
  is still owed before the next release.

## Next up

0. **Hand checks for the pushed stack before the next release:**
   - macOS trackpad pinch on PDF, Word, text and HTML views, including a
     rotated page and a pinch held still for over a second; ctrl+wheel
     after a pinch;
   - reopen a PDF at fit-width on page 5: it lands on that page's top;
   - View > Zoom In/Out walks the toolbar steps; Ctrl+Tab switcher open +
     Delete leaves the selected annotation alone;
   - an encrypted PDF (fixtures in `crates/shiori-core/tests/fixtures/
     encrypted/`, passwords in its README): annotate, export, reopen with
     the user and the owner password; print; insert pages;
   - desktop after the lib.rs split: open/save dialogs, second-instance
     open, Markdown relative image, folder sidebar, Browser panel, terminal
     `open https://…`, menu + immersive mode, quit with unsaved edits;
   - release CI is the first real Windows/Linux/Android/iOS build of the
     split; Android also owes A0.13 (item 2).
1. **Windows walk-through of the new window chrome** (msi from the next
   release): Ctrl+P / Ctrl+, / Ctrl+Z / Ctrl+= still
   work with the menu bar hidden; the window resizes from every edge and
   keeps its shadow and rounded corners; maximized, nothing is clipped at
   the screen edges (tao can lose ~8px to the invisible frame); title-bar
   drag, double-click to maximize, Aero Snap by dragging; the middle button
   flips to Restore after Win+Up; close with unsaved edits asks first; close
   works with Settings or a dialog open; reader mode; dark mode hover
   colours; the new scrollbars; at 600px wide, the home screen's hero
   scrollbar now sits against the column divider (the divider moved onto
   the hero). muda still attaches the menu to the undecorated window before
   `hide_menu` detaches it — expect no menu bar, but look. Snap Layouts on hovering maximize is known
   lost (would need tauri-plugin-decorum). The `hide_menu` line has never
   been compiled for Windows — the release CI is the first build.
2. **Before the next app release:** walk `RELEASE-CHECKS.md` on real devices,
   Android first — A0.13 (wasm engine) is new and blocking.
3. **Rust PDF core leftovers** (plan status line): 3.6 Windows IPC timing,
   A0.12 on Windows/Linux, CLI Linux/Windows `cli-verify` after the push;
   5.2 (native PDFium on Android) is performance only and needs an Android
   environment.
4. **Drop the old APK path a few months after the next Android release:**
   builds from then on ask `/api/release?apkRepo=shiori` and accept only the
   renamed repo; the bare route still rewrites the APK URL to
   `shiori-releases` for 26.9.27 and older. Once those need not self-update,
   delete `legacyApkDownloadUrl` and `wantsLegacyApkPath` in
   `site/functions/_release.ts`.
5. Target-page-first open: on a 500-page synthetic PDF the prep chain (load +
   page info + annotation import) takes a median 154 ms; measure
   first-target-page time on a large real PDF before splitting it.
