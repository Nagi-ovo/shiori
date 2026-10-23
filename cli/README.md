# Shiori CLI

Shiori CLI is the non-interactive PDF inspection and annotation companion for
Shiori. Release packages are self-contained bundles built around a native
executable; users do not need Bun or Node.js.

## Commands

```text
shiori inspect <file>
shiori text <file>
shiori search <file> <query>
shiori render <file.pdf> --page 1 -o page.png
shiori extract <file.pdf> --as-spec > annotations.json
shiori annotate <input.pdf> --highlight "quoted text" -o <output.pdf>
shiori annotate <input.pdf> --spec annotations.json -o <output.pdf>
shiori app context
shiori app annotate --spec annotations.json --base-sha256 <hash>
```

For PDFs, structured search results include resolved matched-text glyph-band
`rects`, their union `rect`, and the page in PDF user space (points,
bottom-left origin). PDF text extraction often exposes one width for a combined
run, so per-character slicing inside that run is estimated rather than exact.
The geometry is suitable for markup anchors; `rect` is only a reference bound
for free text. Choose and adjust an explicit
`{ "type": "text", "page": ..., "rect": ..., "text": ... }` placement so
direct page text never silently covers the source quote. Visual line wraps,
wrap hyphenation, CJK compatibility forms, and copied whitespace share the same
matching contract as quote anchors; detected paragraph/column gaps remain hard
boundaries.

Run `shiori --help` or `shiori help <command>` for the complete strict
command contract. `--agent` writes compact JSON. Unknown options, extra
arguments, invalid page ranges, and unsafe output replacements fail instead of
being silently ignored.

## Live app API

`shiori app context` reads the PDF currently open in the desktop app.
`shiori app annotate` applies a spec to that in-memory document and does not
write a PDF file on disk. Use `--dry-run` to validate without changing the
document and `--base-sha256 <hash>` to fail closed if the active target changed.
Before POSTing, the CLI derives a canonical operation ID from the PDF hash,
page-topology hash, and spec. Retrying the same spec against the same unchanged
PDF therefore reuses the same ID and cannot duplicate annotations. If the POST
times out or its response is lost, `ERR_APP_OUTCOME_UNKNOWN` explicitly tells
the caller not to assume nothing was added. Its error detail includes the
original operation ID, PDF hash, and page-topology hash. Before retrying, read
`app context` again, verify both hashes, and reuse the same spec plus
`--base-sha256`; switching tabs and blindly rerunning is not an exact retry.
An operation stays applied even after Undo in the app, so the same spec adds
nothing a second time; `--nonce <value>` with a value not used before makes it
a new operation, and repeating that value retries it.

The desktop app publishes a short-lived descriptor in its platform cache
directory. The CLI validates its schema, token, PID, port, and Unix file
permissions, then connects only to `127.0.0.1` with bearer authentication.
`SHIORI_LIVE_API_DESCRIPTOR` may point to an absolute descriptor path for tests
or administrator-managed installations. The descriptor token is never printed.

## Annotation safety

- The portable CLI writes only to a new output path. It never replaces an
  existing file, because pure Node cannot atomically preserve ACLs, extended
  attributes, and Windows security metadata across every supported platform.
- Legacy `--force` / `--in-place` flags are parsed for a stable contract, but
  replacing an existing file returns `ERR_NATIVE_ATOMIC_REPLACE_REQUIRED`.
  Choose a new `-o` path.
- `--dry-run --agent` returns the planned write and source SHA-256.
- `--base-sha256 <hash>` prevents applying a patch to a changed input.
- Encrypted PDFs are read-only because the current writer cannot safely
  preserve their encryption.
- `extract --as-spec` emits pure `shiori.annotations/v1` JSON that can be fed
  directly to `annotate`.
- Schema v1 is a portable, canonical subset of nine PDF annotation types:
  highlight, underline, strikethrough, note, callout, ink, rectangle, stamp,
  and text.
  It rejects fields that standard PDF annotations cannot reliably recover,
  including filled rectangles, signature-only ink metadata, explicit CJK font
  families, and highlight opacity above 0.45. Page-content replacement and
  images are deliberately not accepted as annotations.

## Release package layout

Keep the executable, `assets/`, `node_modules/`, `README.md`,
`THIRD_PARTY_NOTICES.md`, and `licenses/` together. Moving only the executable
will break rasterization, CMaps, standard fonts, ICC profiles, WASM decoders,
and CJK export fonts. Set
`SHIORI_CLI_ASSET_DIR` only when an administrator deliberately installs the
asset directory elsewhere.

Linux packages are explicitly named `linux-x64-gnu` and
`linux-arm64-gnu`: they are built and tested against glibc on Ubuntu. They do
not claim compatibility with musl-based distributions such as Alpine Linux.

## Download

One line per platform family. Both fetch a self-contained archive from
`https://shiori.nagi.fun/api/cli`, check it against the SHA-256 GitHub
recorded at upload.

Signing state: `cli-release.yml` Developer ID signs and notarizes the macOS
executable (since `1d0cf953`), so the first signed macOS build is the next
`cli-v` release — the live `cli-v0.1.25` archives predate it and carry only an
ad-hoc signature. Windows has no Authenticode certificate.

```text
macOS, Linux   curl -fsSL https://shiori.nagi.fun/cli | sh
Windows        irm https://shiori.nagi.fun/cli.ps1 | iex
anywhere       npm install -g @nagi-ovo/shiori # needs Node
```

Three implementations of one protocol: same release descriptor, same SHA-256
check against the digest GitHub recorded at upload, same fail-closed
behaviour.

The npm package exists for people who reach for npm, not for platform
coverage — the two shell one-liners already cover every target, and they do
it without requiring Node or putting a registry in the trust path. It is a
fetcher, never the source: `cli/npm/` ships `install.mjs` and a bin stub and
nothing else, and `files` in its package.json keeps it that way. Publish with
`bun run cli:npm-publish`.

`npm install -g @nagi-ovo/shiori@<version>` does NOT pin a CLI version — the fetcher installs
whatever `/api/cli` reports as newest. The package version is kept in lockstep
with `cli/package.json` so the two numbers at least never disagree; a test
enforces it.

Until a `shiori-cli-<version>-<target>.tar.gz` with a GitHub SHA-256 digest is
on the download channel, both commands fail closed instead of installing an
ad-hoc build. A `cli-v<version>` tag runs
`.github/workflows/cli-release.yml`, which packs all five targets and uploads
them to a `cli-v<version>` release in this repository.

The CLI versions independently of the app — `cli/package.json` says 0.1.25
while the app says 26.9.x — so it gets its own tag namespace rather than
riding `v*`. Two releases carrying the same `shiori-cli-0.1.25-*.tar.gz` is
exactly the ambiguity `/api/cli` then has to resolve.

Pushing that tag IS the decision to distribute: the workflow uploads under a
draft and publishes once all five archives are in, so a version appears to
`/api/cli` complete or not at all. The CLI has been public since
`cli-v0.1.25` (2026-09-13), MIT like the rest of the repository.

## Installer terminal UI

`installer/terminal-ui.sh` is the POSIX presentation layer for the hosted curl
installer. `installer/install.sh` does the download, digest check, extract, and
PATH link. `installer/install.ps1` is the Windows equivalent, with no
presentation layer and no dependency beyond what Windows ships.
`bun run cli:installer-assemble` writes both hosted copies —
`site/public/cli.sh` served at `/cli` by a Pages Function, and
`site/public/cli.ps1` served as a static asset with a `_headers` rule that
forces `text/plain` so `irm` hands `iex` a string rather than bytes.

Both hosted copies are generated, and `cli/test/distribution.test.ts` fails if
either drifts from its source.

Preview the choreography without downloading:

```text
bun run cli:installer-demo
```

To preview only the logo reveal, run `sh cli/installer/demo.sh --logo-only`.
To preview its `栞` lyric bookmark, run
`sh cli/installer/demo.sh --quote-only`.

## Internal development

From the repository root:

```text
nvm use                    # reads the repository's .nvmrc (Node 26.5.0)
bun run shiori --help
bun run cli:build
bun run cli:manifest
bun run cli:smoke
```

The source is MIT-licensed like the rest of the repository (`LICENSE`).
`cli/package.json` is marked `"private": true`, so it is never published to
npm itself; the npm package `@nagi-ovo/shiori` (`cli/npm/`) only downloads and
runs the release binary.

`cli:build` is a local verification build and uses an ad-hoc signature on
macOS. Releases must be built on a matching OS/architecture runner with
Node.js 26.5.0 and Bun 1.4.4 pinned, then Developer ID signed + notarized on macOS and
Authenticode signed on Windows. Sign the executable and the native libraries
in `native/` (the shiori-core addon and PDFium). The generated manifest hashes every packaged file, but it is
not itself a signature. After platform signing, run `bun run cli:manifest` to
recompute the existing package's inventory without rebuilding or deleting any
signed file. Then publish through the `cli-v*` release. Do not ship ad-hoc
binaries to users.

The `cli-verify` workflow exercises the supported OS/architecture matrix.
Packed archives are uploaded only from manual `workflow_dispatch` runs; those
unsigned artifacts are verification outputs, not user downloads.

## Release checklist

- [ ] A green `cli-verify` matrix for the five supported targets — macOS
  arm64, Windows arm64/x64, glibc Linux arm64/x64 — on matching runners with
  Node.js 26.5.0 pinned. darwin-x64 is dropped (upstream Node SEA bug,
  POSTMORTEMS 2026-08-17).
- [x] macOS: `cli-release.yml` signs with the Developer ID identity, hardened
  runtime and a timestamp, verifies the authority, then notarizes. Needs the
  `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`, `MACOS_SIGN_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD` and `APPLE_TEAM_ID` secrets; without them the build falls
  back to ad-hoc and the verify step is skipped.
- [ ] Authenticode sign the Windows executable and the libraries in
  `native/` (no certificate exists yet; an unsigned executable is the main
  source of antivirus false positives there), and apply the chosen Linux
  packaging signature. On macOS `cli/build.ts` signs `native/` with the
  executable's identity.
- [ ] After platform signing, run `bun run cli:manifest` to regenerate the
  package inventory without rebuilding signed files, then `bun run cli:pack`.
  A `cli-v<version>` tag runs `.github/workflows/cli-release.yml`, which packs
  all five targets and uploads `shiori-cli-<version>-<target>.tar.gz` to this
  repository's release; the curl and PowerShell installers resolve that name
  from `/api/cli`.
- [ ] Run a dependency/license scan and compare it with `SBOM.md` on every
  lockfile change; keep `LICENSE` and all third-party notices in the archive.
- [ ] Test install, offline use, update and downgrade on every platform.
