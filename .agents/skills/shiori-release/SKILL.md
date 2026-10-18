---
name: shiori-release
description: Release and verify Shiori desktop builds. Use this whenever you are preparing or cutting a Shiori release, bumping the version and tagging, updating the GitHub release or the `gh-pages` branch, publishing or checking Tauri updater manifests (`alpha/latest.json`, `notes/<version>.json`), handling release notes, or debugging updater errors such as "The signature verification failed" or clients that fail to auto-update. Treat updater signing as a release blocker and verify the live manifest before announcing — even if the user only says "发版" / "ship a new version" without naming the updater.
---

# Shiori Release

## Overview

A Shiori release lives in this repo in three places: the `vX.Y.Z` tag on
`main`, the GitHub release for that tag (installers, packages and updater
signatures), and the `gh-pages` branch, which GitHub Pages serves as
`https://updates.shiori.nagi.fun` (`alpha/latest.json`, `notes/<version>.json`).
Treat updater signing as a release blocker: the live manifest must point at
the exact asset bytes whose `.sig` produced the manifest signature.

Keep `gh-pages` checked out as a worktree beside the repo, once:

```bash
git worktree add ../shiori-pages gh-pages
```

## Release Flow

This flow covers the app (`v*` tags). The CLI is not part of it: it releases
on its own `cli-v*` tag namespace through `.github/workflows/cli-release.yml`
into its own GitHub release, so an app tag never re-uploads CLI archives.

1. The version is the release date, `YY.M.D` (26.9.26 ships on 2026-09-26),
   not the previous version plus one; check `date` first. Bump it in
   lockstep: `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml` (+ `Cargo.lock`), `package.json`,
   `site/package.json`. Fold the accumulated `[未发布]` batch into the
   `[X.Y.Z]` section of `CHANGELOG.md` and the trilingual user-facing
   changelogs (`docs/changelog/{en,zh,ja}.md`), then run
   `bun run scripts/prepare-release-notes.ts`: it takes the next epigraph from
   `src/release/epigraphs.ts`, writes `> <codename>` under each version
   heading, and writes `notes/<version>.json` into `../shiori-pages` (pass
   `--pages <dir>` for another gh-pages checkout; it refuses anything not on
   `gh-pages`). For Android, do not
   hand-pin `bundle.android.versionCode` unless there is a deliberate
   migration plan; the direct APK must have a package `versionCode` greater
   than the last shipped Android build, not just a newer `versionName`.
2. **Changelog review gate (always, before building or tagging).** Show the
   user the user-facing changelog and wait for their explicit OK before
   spending build time or touching the tag. See "Changelog Review Gate" below
   for exactly what to print.
3. Run `bun run verify` (build, lint, full test suite, site) before tagging.
4. Walk the device checks in `RELEASE-CHECKS.md` that the release touches,
   or get the user's explicit decision to ship without them. 26.9.8 shipped
   with none and broke twice on real phones.
5. Build macOS locally with `./scripts/build-signed.sh`.
6. Push the source release commit, create an annotated `vX.Y.Z` tag on that
   exact commit, and push the tag. This tag is what triggers
   `.github/workflows/release.yml`; do not stop after the local macOS build.
7. Confirm the GitHub Actions release run exists and let it build Windows,
   Linux, and Android from the tag. Its jobs run in the `release`
   environment (the signing secrets live there) and upload installers,
   packages, and updater signatures to this repo's `vX.Y.Z` release.
8. Finish the release:
   - upload the macOS assets to the `vX.Y.Z` release
   - write the release body, then publish the release (it starts as a draft)
   - in `../shiori-pages`: `notes/<version>.json` (from step 1) and
     `alpha/latest.json` built from the final assets (see "Final Asset
     Gate"), committed and pushed to `gh-pages`
9. Wait for the GitHub Pages deployment of `gh-pages` to finish, then verify
   the live endpoint `https://updates.shiori.nagi.fun/alpha/latest.json`. Do
   not rely only on raw GitHub content.
10. Only announce the release after the live updater manifest verifies.

## Changelog Review Gate

Before any build or tag, print the **user-facing** changelog for the new
version directly in the reply (not just in a tool result the user has to dig
for) and pause for the user to approve or request edits. This is a hard gate:
do not start `build-signed.sh` or push the tag until the user signs off.

- Print the section for the new version from `docs/changelog/zh.md` rendered as
  markdown in the reply. Default to the language the user is writing in; offer
  the `en`/`ja` versions if they want to check those too.
- After the changelog, give a one-line shape summary (e.g. "6 新增 / 12 改进 /
  6 修复") and call out what you deliberately dropped from the maintainer
  `CHANGELOG.md` when condensing to the user-facing list (internal/engineering
  items, minor polish), so the user can pull anything back.
- This is for the trilingual user-facing changelogs and `notes/<version>.json`
  — the in-app, user-visible copy. The maintainer `CHANGELOG.md` (with SHAs and
  engineering detail) does not need sign-off, but show its section too if asked.

## Updater Signing Rules

- `src-tauri/tauri.conf.json` keeps `bundle.createUpdaterArtifacts` off by
  default so ordinary local builds do not require the updater private key.
  Release entry points must explicitly pass
  `--config '{"bundle":{"createUpdaterArtifacts":true}}'`.
- `src-tauri/tauri.conf.json` contains the updater public key. Do not rotate it
  unless there is an explicit migration plan; old clients trust only the baked
  key.
- Each `platforms[*].signature` in `alpha/latest.json` is the exact text from
  the updater `.sig` file for `platforms[*].url`. The `.sig` file already
  contains base64 text; copy it verbatim and do not base64-encode it again.
- CI release upload steps must assert the updater `.sig` files exist before
  uploading. Missing signatures should fail the workflow before a release asset
  is published.
- Windows: `windows-x86_64.url` points at
  `Shiori_<version>_x64_en-US.msi`; `windows-x86_64.signature` must equal the
  contents of `Shiori_<version>_x64_en-US.msi.sig`.
- macOS: both `darwin-aarch64` and `darwin-x86_64` may point at the same
  universal `.app.tar.gz`; both signatures must match that tarball's `.sig`.
- Linux auto-update uses the `.AppImage` and `.AppImage.sig`; `.deb` is only a
  manual install artifact.
- If any asset is replaced with `gh release upload --clobber`, regenerate or
  re-copy the corresponding manifest signature. Same filename does not imply
  same signature.

## Verification

Run the bundled verifier after updating `alpha/latest.json` and again after
GitHub Pages reports built:

```bash
node .agents/skills/shiori-release/scripts/verify-updater-manifest.mjs \
  --manifest https://updates.shiori.nagi.fun/alpha/latest.json \
  --config src-tauri/tauri.conf.json
```

To check only Windows while investigating a user report:

```bash
node .agents/skills/shiori-release/scripts/verify-updater-manifest.mjs \
  --platform windows-x86_64
```

The verifier must show both:

- manifest signature equals the remote `.sig` asset
- minisign verification passes against the asset downloaded from the manifest
  URL

Also verify the GitHub release page itself before announcing:

- the release is not a draft
- the release body is not a placeholder and summarizes the same user-facing
  changes as `notes/<version>.json`
- the asset list includes every platform artifact and updater signature
- the direct Android APK's package metadata matches the release:
  `versionName == <version>` and `versionCode` is newer than the previous
  Android package. `0.1.24` should derive to `1024`, not reuse an older code
  such as `1018`.

## Failure Triage

When users see `The signature verification failed`, start with the live
manifest. It usually means one of:

- `latest.json` copied a stale signature.
- The release asset was re-uploaded after the manifest was generated.
- The manifest URL points at one file while the signature belongs to another.
- The client public key differs from the key used to sign the updater artifact.

Do not rerun CI by reflex. If the release asset and its `.sig` are already
correct, patch `alpha/latest.json`, wait for Pages, and rerun the verifier.
Rerun CI only when the installer/AppImage/tarball itself or its `.sig` is
missing, unsigned, or not the artifact you intend to ship.

## Known Pitfalls

### Stale target-dir artifacts trick readiness checks (v0.1.25)

`build-signed.sh` does NOT clean between versions, and the macOS updater
tarball is written to a fixed, **unversioned** path:
`src-tauri/target/<arch>-apple-darwin/release/bundle/macos/Shiori.app.tar.gz`
(+ `.sig`). The previous version's `Shiori.app.tar.gz`, its `.sig`, and the
previous `Shiori_<oldversion>_universal.dmg` all survive in that dir. A
readiness/wait loop keyed on the existence of `Shiori.app.tar.gz.sig` (or any
unversioned bundle path) fires immediately on the STALE prior-build file — in
v0.1.25 this made a wait loop "succeed" while the universal build was still
compiling, and nearly staged a 2-week-old `_universal` tarball into the
release. Always gate on the NEW version's *versioned* artifact
(`Shiori_<version>_universal.dmg`, produced only after that arch's notarize +
staple) or check the mtime is from this build — never the unversioned
`.app.tar.gz`. Same trap when copying artifacts to staged upload names: verify
the size/mtime, since the universal tarball is ~34 MB and the aarch64-only one
~17 MB — a wrong-arch copy is silently plausible.

### Workflow artifacts refused, release upload skipped (v26.9.26)

The account's Actions storage quota filled up, `upload-artifact` failed, and
because the release upload came after it, the tag run built Linux and
published nothing. Artifact uploads are now `continue-on-error` and happen
only on analysis runs (a tag, publishing off), and the Play Console AAB goes
to a `play-aab-<tag>` draft release (drafts are visible only to
collaborators with push access). The quota is metered in
GB-hours per billing month: deleting every artifact stops the growth but
refunds nothing, so uploads stay refused until the month resets. If a tag run still fails, fix the
workflow on `main` and re-run with `workflow_dispatch` (`tag=vX.Y.Z`,
`publish_to_release_repo=true`) rather than moving the tag: the app code is
the tagged commit's, only `.github/` differs. A test APK for device checks
comes from a dispatch with `android_only=true`, `android_artifacts=apk`,
publishing off; it lands in a `qa-android-<run>` draft.

The site changelog tests once pinned `releases[0]` to the last version and
failed every bump; they now check a shipped release. If a test breaks on the
version bump alone, look for that pattern before touching the changelog.

### Stale manifest signature (v0.1.5)

In v0.1.5, Windows clients from v0.1.4 failed to update because
`alpha/latest.json` contained a stale `windows-x86_64.signature`. The GitHub
release's `.msi.sig` verified the MSI, but the manifest embedded a different
signature. Fixing only `alpha/latest.json` was sufficient; existing v0.1.4
clients could update successfully after fetching the corrected manifest.

## Final Asset Gate

Before declaring a release complete, follow this order without shortcuts:

1. Wait for the final pushed-tag workflow and every release-upload step to
   succeed.
2. After all `--clobber` uploads finish, download the final release assets and
   their `.sig` files again. Never reuse signatures from an RC, dry run, or an
   earlier draft upload.
3. Build `alpha/latest.json` only from those final files, then confirm every
   embedded signature exactly matches the current remote `.sig`.
4. Deploy the manifest and run the live verifier for every platform. Any
   mismatch is a release blocker even when the filenames are unchanged.
