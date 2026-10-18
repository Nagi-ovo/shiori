#!/bin/sh

# Authenticated-channel curl installer for the Shiori CLI.
# This file is POSIX sh so a clean macOS/Linux machine can run
# `curl -fsSL https://shiori.nagi.fun/cli | sh` before Node or Bun exists.
# On native Windows, use `irm https://shiori.nagi.fun/cli.ps1 | iex` — the
# PowerShell installer reads the same release descriptor and the same archive.

set -eu

if [ "${SHIORI_INSTALLER_EMBEDDED:-0}" != 1 ]; then
  SHIORI_INSTALLER_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  # shellcheck disable=SC1091
  . "$SHIORI_INSTALLER_DIR/terminal-ui.sh"
fi

SHIORI_CLI_API="${SHIORI_CLI_API:-https://shiori.nagi.fun/api/cli}"
SHIORI_CLI_HOME="${SHIORI_CLI_HOME:-${HOME:?HOME is required}/.shiori}"
SHIORI_CLI_BIN_DIR="${SHIORI_CLI_BIN_DIR:-$HOME/.local/bin}"

shiori_cli_detect_target() {
  shiori_cli_os=$(uname -s | tr '[:upper:]' '[:lower:]')
  shiori_cli_arch=$(uname -m | tr '[:upper:]' '[:lower:]')
  case "$shiori_cli_os" in
    darwin)
      case "$shiori_cli_arch" in
        arm64) printf '%s\n' darwin-arm64 ;;
        *)
          printf 'This installer does not support macOS %s. Apple Silicon only.\n' \
            "$shiori_cli_arch" >&2
          return 2
          ;;
      esac
      ;;
    linux)
      case "$shiori_cli_arch" in
        x86_64|amd64) printf '%s\n' linux-x64-gnu ;;
        aarch64|arm64) printf '%s\n' linux-arm64-gnu ;;
        *)
          printf 'This installer does not support Linux %s.\n' "$shiori_cli_arch" >&2
          return 2
          ;;
      esac
      ;;
    mingw*|msys*|cygwin*)
      printf 'On Windows, install from PowerShell with:\n' >&2
      printf '  irm https://shiori.nagi.fun/cli.ps1 | iex\n' >&2
      return 2
      ;;
    *)
      printf 'Unsupported OS %s.\n' "$shiori_cli_os" >&2
      return 2
      ;;
  esac
}

shiori_cli_require_https() {
  case "$1" in
    https://*) return 0 ;;
    http://127.0.0.1:*|http://localhost:*|http://[::1]:*)
      if [ "${SHIORI_CLI_ALLOW_HTTP:-0}" = 1 ]; then
        return 0
      fi
      ;;
  esac
  printf 'Refusing a non-HTTPS download URL.\n' >&2
  return 1
}

shiori_cli_parse_env() {
  SHIORI_CLI_AVAILABLE=0
  SHIORI_CLI_VERSION=
  SHIORI_CLI_TARGET=
  SHIORI_CLI_URL=
  SHIORI_CLI_SHA256=
  while IFS= read -r shiori_cli_line || [ -n "$shiori_cli_line" ]; do
    [ -z "$shiori_cli_line" ] && continue
    shiori_cli_key=${shiori_cli_line%%=*}
    shiori_cli_value=${shiori_cli_line#*=}
    case "$shiori_cli_key" in
      SHIORI_CLI_AVAILABLE)
        case "$shiori_cli_value" in
          0|1) SHIORI_CLI_AVAILABLE=$shiori_cli_value ;;
          *)
            printf 'Malformed release descriptor.\n' >&2
            return 1
            ;;
        esac
        ;;
      SHIORI_CLI_VERSION)
        case "$shiori_cli_value" in
          [0-9]*.[0-9]*.[0-9]*) SHIORI_CLI_VERSION=$shiori_cli_value ;;
          *)
            printf 'Malformed release version.\n' >&2
            return 1
            ;;
        esac
        ;;
      SHIORI_CLI_TARGET)
        case "$shiori_cli_value" in
          darwin-arm64|linux-arm64-gnu|linux-x64-gnu|win32-arm64|win32-x64)
            SHIORI_CLI_TARGET=$shiori_cli_value
            ;;
          *)
            printf 'Malformed release target.\n' >&2
            return 1
            ;;
        esac
        ;;
      SHIORI_CLI_URL)
        shiori_cli_require_https "$shiori_cli_value" || return 1
        SHIORI_CLI_URL=$shiori_cli_value
        ;;
      SHIORI_CLI_SHA256)
        case "$shiori_cli_value" in
          [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]*)
            if [ "${#shiori_cli_value}" -ne 64 ]; then
              printf 'Malformed archive digest.\n' >&2
              return 1
            fi
            SHIORI_CLI_SHA256=$(printf '%s' "$shiori_cli_value" | tr '[:upper:]' '[:lower:]')
            ;;
          *)
            printf 'Malformed archive digest.\n' >&2
            return 1
            ;;
        esac
        ;;
      SHIORI_CLI_SIZE) ;;
      *)
        printf 'Unexpected field in release descriptor.\n' >&2
        return 1
        ;;
    esac
  done
}

shiori_cli_sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    printf 'Need sha256sum or shasum to verify the archive.\n' >&2
    return 1
  fi
}

shiori_cli_download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    printf 'Need curl or wget to download Shiori CLI.\n' >&2
    return 1
  fi
}

shiori_cli_link_path() {
  if [ ! -d "$SHIORI_CLI_BIN_DIR" ]; then
    mkdir -p "$SHIORI_CLI_BIN_DIR"
  fi
  ln -sfn "$1" "$SHIORI_CLI_BIN_DIR/shiori"
  chmod 755 "$1" "$SHIORI_CLI_BIN_DIR/shiori" 2>/dev/null || chmod 755 "$1"
}

shiori_cli_install() {
  shiori_cli_target=$(shiori_cli_detect_target)
  printf 'Resolving release\n'
  shiori_cli_env=$(mktemp "${TMPDIR:-/tmp}/shiori-cli-env.XXXXXX")
  shiori_cli_archive=$(mktemp "${TMPDIR:-/tmp}/shiori-cli-archive.XXXXXX")
  trap 'rm -f "$shiori_cli_env" "$shiori_cli_archive"' EXIT INT TERM HUP
  if ! shiori_cli_download \
    "$SHIORI_CLI_API?target=${shiori_cli_target}&format=env" \
    "$shiori_cli_env"
  then
    printf 'Could not reach the Shiori release API.\n' >&2
    return 1
  fi
  shiori_cli_parse_env < "$shiori_cli_env"
  if [ "$SHIORI_CLI_AVAILABLE" != 1 ]; then
    printf 'Shiori CLI is not on the download channel yet.\n' >&2
    printf 'The installer is ready; no archive has been published.\n' >&2
    return 1
  fi
  if [ "$SHIORI_CLI_TARGET" != "$shiori_cli_target" ]; then
    printf 'Release target mismatch.\n' >&2
    return 1
  fi
  printf 'Downloading Shiori CLI for %s\n' "$shiori_cli_target"
  shiori_cli_download "$SHIORI_CLI_URL" "$shiori_cli_archive"
  printf 'Verifying archive digest\n'
  shiori_cli_actual=$(shiori_cli_sha256_file "$shiori_cli_archive")
  if [ "$shiori_cli_actual" != "$SHIORI_CLI_SHA256" ]; then
    printf 'Archive digest mismatch.\n' >&2
    return 1
  fi
  printf 'Extracting self-contained package\n'
  shiori_cli_dest="$SHIORI_CLI_HOME/cli/$SHIORI_CLI_VERSION"
  mkdir -p "$shiori_cli_dest"
  tar -xzf "$shiori_cli_archive" -C "$shiori_cli_dest"
  if [ ! -x "$shiori_cli_dest/shiori" ] && [ -f "$shiori_cli_dest/shiori" ]; then
    chmod 755 "$shiori_cli_dest/shiori"
  fi
  if [ ! -f "$shiori_cli_dest/shiori" ]; then
    printf 'Archive did not contain shiori.\n' >&2
    return 1
  fi
  ln -sfn "$shiori_cli_dest" "$SHIORI_CLI_HOME/cli/current"
  printf 'Linking shiori into PATH\n'
  shiori_cli_link_path "$shiori_cli_dest/shiori"
}

shiori_cli_usage() {
  printf 'Usage: %s [--print-target]\n' "$0" >&2
  return 2
}

case "${1:-}" in
  --print-target)
    shiori_cli_detect_target
    ;;
  --parse-env)
    shiori_cli_parse_env
    printf '%s %s %s %s\n' \
      "$SHIORI_CLI_AVAILABLE" \
      "${SHIORI_CLI_VERSION:-}" \
      "${SHIORI_CLI_TARGET:-}" \
      "${SHIORI_CLI_SHA256:-}"
    ;;
  --help|-h)
    shiori_cli_usage
    ;;
  "")
    shiori_installer_logo_animation
    shiori_installer_quote_animation
    if [ -n "${SHIORI_UI_DIM:-}" ]; then
      printf '%s  Local documents. Agent-ready.%s\n\n' "$SHIORI_UI_DIM" "$SHIORI_UI_RESET"
    fi
    shiori_installer_run_with_progress "Installing Shiori CLI" shiori_cli_install
    printf '\nRun it with: shiori --help\n'
    case ":${PATH}:" in
      *":$SHIORI_CLI_BIN_DIR:"*) ;;
      *)
        printf 'Add %s to PATH if the shell cannot find shiori.\n' "$SHIORI_CLI_BIN_DIR"
        ;;
    esac
    ;;
  *)
    shiori_cli_usage
    ;;
esac
