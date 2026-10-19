# AGENTS.md

Project instructions for coding agents working in this repo (Claude Code reads
this file when no CLAUDE.md exists; Codex reads it directly).

## Communication

- Reply in the language of the user's latest message (Chinese → Chinese,
  English → English); mix only if the user mixes first.
- Before the first tool call, say in one sentence what you are about to do.
  While working, speak up when you find something or change direction. When
  you finish, lead with the outcome ("what happened / what I found"), then the
  detail, then what you need from the user.
- Deliver what was asked, at the scope intended. If the request looks mistaken
  or a better approach exists, say so in a sentence and carry on as asked;
  a bug fix does not bring a refactor along. Check in only when two readings
  of the request lead to materially different work.

## Project at a glance

**Shiori 栞** — a local-first document reader and PDF editor. One React +
TypeScript codebase ships as web (static host), desktop (Tauri 2 wrapping the
same `dist/`: macOS, Windows, Linux) and Android (Tauri mobile). The CLI
lives in `cli/` and releases on its own `cli-v*` tags. Open source: code
under MIT (`LICENSE`), brand assets under `TRADEMARK.md`.

- Frontend: React 19, TypeScript, Vite 8, Zustand, react-virtuoso, @dnd-kit
- PDF: PDFium through `crates/shiori-core` is the only reader everywhere
  (native on desktop, wasm in a worker on web/mobile, a napi addon in the
  CLI); `pdf-lib` + `@pdf-lib/fontkit` write exports and read annotations for
  import.
- Word: `@docx-editor.dev/*` (third-party DOM editor; upstream ships often,
  keep it current)
- Markdown: CodeMirror 6 live editor + `marked` preview; code blocks highlight
  with the same Lezer parsers in both (`src/documents/codeHighlight.ts`)
- Storage: IndexedDB via Dexie, for draft autosave
- i18n: `react-i18next` with `en` / `zh` / `ja` JSON dictionaries
- Package manager: bun (not npm/yarn/pnpm)
- Desktop shell: Tauri 2 (`src-tauri/`); macOS aarch64 dmg is ~26 MB

## Architecture facts worth remembering

Code and docs cite these by number, so keep the numbering.

1. **All overlay coordinates are in PDF user space** (points, origin at page
   bottom-left). DOM pixel coords exist only transiently during render /
   hit-testing. See `src/pdf/geometry/coords.ts`.
2. **One reading engine, one writer.** shiori-core (Rust over PDFium,
   `crates/shiori-core`) opens, draws and reads every PDF through
   `appPdfEngine` (`src/pdf/engine/`): natively on desktop, as wasm in a web
   worker on web and mobile; `PdfDocument` is its opaque handle. pdf-lib reads
   annotations for import (`src/pdf/import/sourceAnnotations.ts`) and writes
   exports. Components never reach PDFium directly; tests swap the engine
   with `setAppPdfEngineForTest` (`src/test/fakePdfEngine.ts`). History and
   decisions: `docs/PLAN-RUST-PDF-CORE-2026-09.md`.
3. **Platform abstraction lives in `src/platform/`.** Only `src/platform/`
   imports `@tauri-apps/*` (statically or via `import()`); ESLint enforces it.
   It branches on `IS_TAURI`, which keeps the web build working.
4. **Draft autosave is keyed by the SHA-256 of the PDF bytes** — the same PDF
   recovers across sessions, a different one never collides
   (`src/storage/drafts.ts`). No age-based expiry, cap 1 GB, LRU eviction.
5. **The bundle identifier is `fun.nagi.shiori`.** Changing it wipes every
   user's IndexedDB drafts and localStorage prefs, so it needs a migration
   plan first.
6. **User-visible strings go through `t()`** with keys in
   `src/i18n/locales/{en,zh,ja}.json`; hardcoded English copy is a regression.
7. **Plugin registration in `src-tauri/src/lib.rs` is load-bearing.** A plugin
   missing its `.plugin(...)` surfaces as a misleading "plugin X not found"
   (`docs/POSTMORTEMS.md`).
8. **Build expiry is opt-in for closed betas.** Public/store builds never
   self-expire. `SHIORI_ENABLE_BUILD_EXPIRY=true` stamps a build timestamp
   (`vite.config.ts`, `src-tauri/build.rs`); the check is
   `src/runtime/expiry.ts`, rendering `ExpiredScreen` from `App.tsx`.
9. **Platform differences are first-class.** A fix touching opening, saving,
   recents, workspace tabs, storage, IPC, drag/drop, file associations or
   share flows traces every route: web picker / drag-drop / File System
   Access; desktop native picker / drag-drop / file association (macOS
   `Opened`, Windows/Linux single-instance argv); mobile picker / share /
   cache. A fix that works only on the platform in front of you is incomplete.
10. **Android distribution is a build-time flag with long reach.**
    `SHIORI_ANDROID_DISTRIBUTION` (default `google-play`) decides whether the
    in-app sideload updater exists at all — only `direct-apk` builds run it,
    so an updater bug stays latent across store builds. Testing in-app updates
    means building with that variable set (`docs/BUILD-AND-RELEASE.md`).
11. **`src/App.tsx` (the ~450-line composition root) and its
    `src/App/*Ports.ts` and `src/App/render/` wiring have no test harness.**
    When a change there needs a test, extract the decision into a seam, test
    the seam, and say in the commit that the wiring itself is uncovered.

Before changing `src-tauri/` commands, capabilities, permissions, plugins or
the updater, read `docs/TAURI-RULES.md`.

## Commands

```bash
bun run dev            # web dev server at localhost:1573
bun run build          # TS + Vite production build to dist/ (compiles shiori-core to wasm)
bun run lint           # ESLint
bun run test           # full bun test suite
bun run test:core      # Rust crates: fmt, clippy, tests, node + wasm bindings
bun run verify         # build + lint + test + site build/lint
bun run tauri:dev      # desktop app with hot reload
bun run tauri build    # local release desktop bundle (.app + .dmg on macOS)
```

- "启动 dev" / "start dev" means the desktop app:
  `. "$HOME/.cargo/env" && bun run tauri:dev`. Use `bun run dev` only when the
  user says web or the task is web-only. Day-to-day, prefer `tauri:dev` (no
  repackage cycle) and keep `bun run tauri build` for release behaviour.
  Launch or relaunch the app only when the user asked you to run something.
- The website is its own Vite project: `cd site && bun run dev` (default
  `http://localhost:5174/`; if the port is busy, use another and tell the user
  the URL).
- Stop processes you started by PID or background-task ID. `pkill -f <word>`
  matches every command line containing the word, Chrome and Electron helpers
  included (2026-09-23: a `pkill -f vite` likely killed the user's Chrome tabs
  and an Electron app).
- Shells that skip the profile lack `cargo`, so chain the env into the same
  command for anything touching Rust or Tauri:
  `. "$HOME/.cargo/env" && <command>`. `bun run build` also needs
  `rustup target add wasm32-unknown-unknown`; the pinned wasm-bindgen CLI
  installs itself into `vendor/tools/`.

## Signed release builds

`bun run tauri build` is an ad-hoc local build. Anything that crosses
Gatekeeper on another Mac — updater artifacts, dmg distribution — goes through
`./scripts/build-signed.sh` (Apple credentials and signing identity:
`docs/BUILD-AND-RELEASE.md`). The release flow lives in the `shiori-release`
skill.

After a `bun run tauri build` you ran, restart the installed app so the user
sees the new bundle, matching the binary by its full path:

```bash
pkill -9 -f "Shiori.app/Contents/MacOS/shiori" 2>/dev/null || true
open "./src-tauri/target/release/bundle/macos/Shiori.app"
```

Shorter patterns kill nothing, `open` then refocuses the stale instance, and
the next hour goes into testing the old bundle (`docs/POSTMORTEMS.md`,
2026-05-30, root cause 6).

## Build / lint / test before commit

A change touching source is sealed only after `bun run verify` passes; add
`bun run test:core` for `crates/` and a `bun run tauri build` for `src-tauri/`.
Build and lint alone are not the gate: `tsconfig.app.json` excludes
`*.test.ts`, so a renamed string or changed signature breaks tests while both
stay green, and any `@ts-expect-error` in a test file is inert.

Two tests are timing-sensitive (`DocxViewer viewport layout > previews a
pinch …` and `ExternalTerminalLauncher > closes on Escape and outside pointer
input`) and flake under CPU contention (a browser session or Rust build
alongside `bun test`). Re-run the file alone before treating a lone failure as
real.

## Tests

A test earns its place by failing when user-visible behavior breaks and
passing through harmless refactors. A test written after the code tends to
restate the code and passes by construction, so the order below matters.

- **E2E first.** Verify a feature by driving the real app along the user's
  path: the web build in a browser (the Chrome tools), the desktop bundle
  (`scripts/perf/tauri-probe.ts` is the in-app harness). Every E2E run ends in
  an artifact someone else can check and regenerate — screenshots, a GIF or a
  JSON report under `test-artifacts/<scenario>/` (gitignored), next to the
  exact command or steps that produce it. No E2E runner is wired into
  `bun run verify` yet; until one is, say in the commit which scenario was run
  and where its artifact is.
- **Failure list, then code, for isolated tests.** When a system must be
  tested alone (a parser, geometry, a policy, a pure transform E2E cannot
  reach cheaply), first write down every way it can fail — inputs, states,
  platforms, races — then the tests from that list, then the code. Unit
  tests are never added after the code they cover.
- **Bug fixes start red.** Reproduce the bug first (an E2E run or a test that
  fails on it), then fix; the same run passing is the evidence (POSTMORTEMS
  2026-08-02: three tests stayed green against nothing). First ask which
  existing test should have caught it.
- **Delete, never add:**
  - *tombstone* tests — asserting that a removed implementation detail stays
    gone (an import, prop, setting key or string no user would miss). A
    user-visible regression phrased "no longer …" is behavior and stays;
  - *tautological* tests — the expected value comes from the production
    logic, the unit under test is mocked, or the assertion can only pass;
  - *change-detector* tests — a regex over a source line, internal call
    sequences, private structure.
- **Static checks are not tests of code.** A source scan or config check
  enforcing a repo-wide invariant with a written reason stays: every `t()`
  key in all locales, a vendored patch still applied, the page-merge ESLint
  rule, hosts in `tauri.conf.json` matching `src/shared/links.ts`, the app
  version agreeing across its five files.
- When App.tsx logic needs a test, extract a seam (fact 11); where each
  property the old App.tsx regex tests policed is now tested is recorded in
  `docs/PLAN-APP-ARCHITECTURE-2026-09.md`.

## Version control: jj (colocated)

The repo is jj-colocated (`.jj/` beside `.git`). The working copy is a commit
(`@`), snapshotted on every jj command, so there is no staging area and
parallel edits are always captured. The `jj` skill holds the workflow, house
rules and parallel-agent workspaces; load it before any jj or git command.

- Seal as you go: when a fix is done and its gates are green, commit it (one
  fix per change) and keep working. Pushing, and rewriting sealed history,
  wait for the user's explicit go.
- Bookmarks do not advance on their own. Before pushing:
  `jj bookmark set main -r @-`, then `jj git push --bookmark main`.
- Tags, releases and fork-PR pushes stay plain git (jj cannot push tags);
  releases go through the `shiori-release` skill.
- Codex run directly by the user may commit with plain `git commit`; jj
  imports it on its next command. Raw `git checkout` / `git branch` mutations
  fight jj's snapshot.
- Project skills live in `.agents/skills/` (Codex reads them there);
  `.claude/skills/` is gitignored and holds symlinks into it, so re-create
  them in a fresh workspace.

## Commit messages

English, imperative, explaining the why; subject ≤ 72 chars. Prefer new
commits over `git commit --amend` or force-pushes. Codex adds the trailer
`Co-authored-by: codex <codex@users.noreply.github.com>`.

## Where knowledge lives

- `docs/POSTMORTEMS.md` — read before debugging Tauri / plugin / IPC, PDF
  export or annotation compatibility, draft recovery, or local cache issues;
  past dead ends are recorded there.
- `HANDOFF.md` — current state and next steps across sessions. Keep it short;
  update it when a session ends with unfinished work.
- `docs/ENV-CURSOR-CLOUD.md` — read when running in a Cursor Cloud Agent VM
  (different PATH, Rust toolchain, no desktop GUI); it does not apply on this
  Mac.
