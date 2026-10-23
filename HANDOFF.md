# Handoff

Current state and next steps only. History lives in `git log`, `CHANGELOG.md`
and `docs/POSTMORTEMS.md` — when an item here is done, delete it rather than
marking it done.

Last reconciled against reality: **2026-10-23**.

## Current state

- **App 26.10.23 (唯我独尊) is the live release**: the whole 2026-10-20
  audit batch (`docs/AUDIT-2026-10-20.md`, all 119 handled). macOS local
  signed + notarized, Windows/Linux/Android from CI; the live updater
  verifier passes on all four desktop platforms. Shipped without device
  checks and not announced, both by Jesse's choice. The GitHub release is
  not flagged latest (`gh release edit --latest` returned 422; the
  latest-release API answers 404). The oracle-arm Discord bot may have
  auto-posted it to `shiori-zh` / `shiori-en`; Jesse decides whether to
  delete.
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
6. **Housekeeping:** archive the old private repo `shiori-dev` (Actions
   off); delete the Cloudflare projects `shiori-promotion` / `shiori-app`
   once rollback is no longer wanted (Jesse's call). The local web build's
   recents still hold B027 probe files.
7. Target-page-first open: on a 500-page synthetic PDF the prep chain (load
   + page info + annotation import) takes a median 154 ms; measure
   first-target-page time on a large real PDF before splitting it.
