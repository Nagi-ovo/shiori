#!/usr/bin/env bash
# Build a signed + notarized Tauri release.
#
# Loads ~/.cargo/env (Rust isn't on PATH by default — see AGENTS.md)
# and project-local secrets from .env.tauri.local, then runs the
# standard `bun run tauri build`, with updater artifacts explicitly
# enabled for release builds. Tauri 2 detects APPLE_ID + APPLE_PASSWORD +
# APPLE_TEAM_ID automatically and runs codesign + notarytool + stapler in
# one shot.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env.tauri.local ]]; then
  echo "error: .env.tauri.local missing — see AGENTS.md → 'Signed release builds'." >&2
  exit 1
fi

# Export every var defined in the env file so the bun child process
# sees them. `set -a` toggles auto-export; `set +a` restores normal mode.
set -a
# shellcheck disable=SC1091
source .env.tauri.local
set +a

if [[ "${APPLE_ID:-}" == "REPLACE_WITH_APPLE_ID_EMAIL" || -z "${APPLE_ID:-}" ]]; then
  echo "error: APPLE_ID in .env.tauri.local is still a placeholder." >&2
  exit 1
fi

# Tauri's updater step in 2.x requires the private *contents* in
# TAURI_SIGNING_PRIVATE_KEY, not just a path. Resolve `~` / `$HOME`
# inside the path (shell expansion inside the sourced dotenv is
# inconsistent across shells) and pipe the file contents in.
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  TAURI_SIGNING_PRIVATE_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH/#\~/$HOME}"
  if [[ ! -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]]; then
    echo "error: TAURI_SIGNING_PRIVATE_KEY_PATH points at a missing file: $TAURI_SIGNING_PRIVATE_KEY_PATH" >&2
    exit 1
  fi
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH")"
  export TAURI_SIGNING_PRIVATE_KEY_PATH
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "error: missing TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH; updater artifacts require the Ed25519 private key." >&2
  exit 1
fi
# Tauri's CLI prompts interactively if PASSWORD is unset, even when
# the key has no password. Without a TTY (running from a script /
# CI / a background process) the prompt errors out with
# "Device not configured". Explicitly export an empty password to
# tell it "no prompt, no password".
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# shellcheck disable=SC1091
. "$HOME/.cargo/env"

# Keep developer machine paths out of shipped Rust binaries without storing
# absolute local paths in repository config.
export SHIORI_REPO_ROOT="$(pwd)"
# shellcheck disable=SC1091
. "./scripts/rust-remap-env.sh"

APP_VERSION="$(sed -nE 's/.*"version": "([^"]+)".*/\1/p' src-tauri/tauri.conf.json | head -1)"

notarize_and_staple_dmg() {
  local dmg="$1"
  if [[ ! -f "$dmg" ]]; then
    echo "error: expected dmg missing after build: $dmg" >&2
    exit 1
  fi

  echo "Notarizing final DMG: $dmg"
  xcrun notarytool submit "$dmg" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait

  echo "Stapling final DMG: $dmg"
  xcrun stapler staple "$dmg"
}

# Produce two signed + notarized dmgs in sequence:
#   1. aarch64-apple-darwin → Shiori_<v>_aarch64.dmg     (Apple Silicon native, ~16 MB)
#   2. universal-apple-darwin → Shiori_<v>_universal.dmg (fat binary, ~30 MB, also runs on Intel)
# Apple Silicon users get the smaller native dmg; Intel users (who can't
# run aarch64-only) get the universal one. Two passes means cargo
# compiles aarch64 once (cached for pass 2) but re-runs lipo + bundle +
# codesign + notarytool per dmg, so total wall-clock is ~1.5–2× a single
# universal build.
#
# Requires both rustup targets installed:
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
#
# Extra args after the script name (`$@`) are forwarded to *both* tauri
# invocations.
bun run tauri build --target aarch64-apple-darwin \
  --config '{"bundle":{"createUpdaterArtifacts":true}}' "$@"
notarize_and_staple_dmg \
  "src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Shiori_${APP_VERSION}_aarch64.dmg"

bun run tauri build --target universal-apple-darwin \
  --config '{"bundle":{"createUpdaterArtifacts":true}}' "$@"
notarize_and_staple_dmg \
  "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Shiori_${APP_VERSION}_universal.dmg"
