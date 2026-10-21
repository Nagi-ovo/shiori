# Handoff

Current state and next steps only. History lives in `git log`, `CHANGELOG.md`
and `docs/POSTMORTEMS.md` — when an item here is done, delete it rather than
marking it done.

Last reconciled against reality: **2026-10-21**.

## Current state

- **The 2026-10-20 audit fixes are on local `main`, not pushed** (2026-10-21):
  all 119 handled; B102 is not a bug. Every fix was then reviewed by Codex
  gpt-6-astra (sol for the parts it had missed) and the 28 findings answered
  (`CHANGELOG.md` `[未发布]` → 复审补修, 收尾). B034 is done: a refused
  window may export or discard (desktop close/quit unit-tested only). Still
  open (未完成): B027, two routes marked `test.failing` in the opt-in Chromium
  suite (`SHIORI_BROWSER_TEST=1 bun test
  src/documents/runnableHtmlWebRtcGuard.browser.test.ts`); the shadow-root
  one needs Jesse to pick between disabling declarative shadow DOM in run
  frames and turning WebRTC off at the host. Web tab close/reload still drops
  a refused copy silently (predates B034). Left as they are by Jesse's call
  (有意不再修): B108 (no PDFium API up to chromium/8111) and B088 (wry
  gesture signals on three engines, two unverifiable here). Gates green on main: verify
  (2440), test:core, src-tauri cargo test, `tauri build`. Waiting on Jesse:
  push, and whether the audit doc's exploit detail stays public.
  Android/iOS/Windows/Linux changes are unverified on device. Worktrees
  `../shiori-fix/*`, `../shiori-fu/*` (branches `fix/*`, `fu*/*`,
  `audit-fixes`) and `_cargo-target` can go once Jesse agrees.

- **Shiori is open source** (2026-10-18). `Nagi-ovo/shiori` is the public
  source repo (formerly `shiori-releases`; releases, tags and the updater's
  `gh-pages` live there too). The old private source repo is `shiori-dev`,
  Actions off, to be archived. Cloudflare Pages deploys from the public repo
  since 2026-10-19: `shiori.nagi.fun` → project `shiori-site`,
  `app.shiori.nagi.fun` → `shiori-web` (DNS: the `@` and `app` CNAMEs in the
  separate Aliyun zone `shiori.nagi.fun`, not the `shiori` record in
  `nagi.fun`). The old projects `shiori-promotion` / `shiori-app` stay for
  rollback until Jesse deletes them. The `release` environment holds every
  signing secret. The Discord bot on `oracle-arm` (`discord-bot.service`,
  `~/Project/nagis_discord/watcher.py`) watches `Nagi-ovo/shiori` since
  2026-10-20; it had silently missed releases because the API answers the
  old name with a 301. Still open: archive `shiori-dev`.

- **26.10.20 shipped the encryption, Canvas viewport, tab strip and lib.rs
  work** (details in `CHANGELOG.md`): encrypted PDFs keep their encryption
  through export, page insertion and printing; the Canvas viewport layer
  (`docs/PLAN-CANVAS-VIEWPORT-2026-10.md`); whole-tab dragging; the
  `src-tauri/src/lib.rs` split (`docs/PLAN-TAURI-MODULES-2026-10.md`). None
  of it was walked by hand on a device; see Next up 0.
- **Open product question:** a signed PDF whose print copy needs a rebuild
  (overlays) is refused printing, though paper has no signature to break.

- **App 26.10.20 (四面楚歌) is the live release** (2026-10-20), the first
  from the public repo: macOS (local signed + notarized), Windows, Linux,
  Android direct APK (versionCode 26010020); `alpha/latest.json` points at
  `Nagi-ovo/shiori` assets and the live verifier passes on all four desktop
  platforms. Announced in the Shiori QQ group and Discord `shiori-zh` /
  `shiori-en`. Released without device checks, by Jesse's decision, A0.13
  (Android wasm engine) included. Epigraph pool: 6 of 20 used.
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
  **Android runs on the wasm engine, shipped in 26.10.20 without a device
  check — A0.13 is still owed; watch for Android reports.** The local desktop bundle was rebuilt and Developer ID signed
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
