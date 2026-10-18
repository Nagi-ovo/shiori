#!/bin/sh

set -eu

SHIORI_INSTALLER_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SHIORI_INSTALLER_DIR/terminal-ui.sh"

shiori_installer_demo_work() {
  printf 'Resolving signed release\n'
  shiori_installer_sleep "${SHIORI_INSTALLER_DEMO_DELAY:-0.55}"
  printf 'Downloading Shiori CLI for darwin-arm64\n'
  shiori_installer_sleep "${SHIORI_INSTALLER_DEMO_DELAY:-0.55}"
  printf 'Verifying archive signature\n'
  shiori_installer_sleep "${SHIORI_INSTALLER_DEMO_DELAY:-0.55}"
  printf 'Extracting self-contained package\n'
  shiori_installer_sleep "${SHIORI_INSTALLER_DEMO_DELAY:-0.55}"
  printf 'Linking shiori into PATH\n'
  shiori_installer_sleep "${SHIORI_INSTALLER_DEMO_DELAY:-0.55}"
}

case "${1:-}" in
  --logo-only)
    shiori_installer_logo_animation
    ;;
  --quote-only)
    shiori_installer_quote_animation
    ;;
  --snapshot-progress)
    shiori_installer_draw_progress 7 'Installing Shiori CLI' 'downloading signed archive'
    printf '\n'
    ;;
  --static)
    TERM=dumb
    export TERM
    shiori_installer_logo_animation
    shiori_installer_run_with_progress 'Installing Shiori CLI' shiori_installer_demo_work
    ;;
  "")
    shiori_installer_logo_animation
    shiori_installer_quote_animation
    printf '%s  Local documents. Agent-ready.%s\n\n' "$SHIORI_UI_DIM" "$SHIORI_UI_RESET"
    shiori_installer_run_with_progress 'Installing Shiori CLI' shiori_installer_demo_work
    printf '\nRun it with: shiori --help\n'
    ;;
  *)
    printf 'Usage: %s [--logo-only|--quote-only|--snapshot-progress|--static]\n' "$0" >&2
    exit 2
    ;;
esac
