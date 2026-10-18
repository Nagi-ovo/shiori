#!/bin/sh

# Terminal presentation shared by the future Shiori CLI curl installer.
#
# This file is intentionally POSIX sh: the hosted installer must work on a
# clean macOS/Linux machine before Shiori, Bun, or Node.js exists. It performs
# no installation by itself; source it, then wrap the real authenticated
# download/install function with shiori_installer_run_with_progress.

SHIORI_UI_ESC=$(printf '\033')
SHIORI_UI_CR=$(printf '\r')
SHIORI_UI_RESET="${SHIORI_UI_ESC}[0m"
SHIORI_UI_BOLD="${SHIORI_UI_ESC}[1m"
SHIORI_UI_DIM="${SHIORI_UI_ESC}[2m"
SHIORI_UI_CLEAR="${SHIORI_UI_ESC}[2J${SHIORI_UI_ESC}[H"
SHIORI_UI_CLEAR_LINE="${SHIORI_UI_ESC}[K"
SHIORI_UI_HIDE_CURSOR="${SHIORI_UI_ESC}[?25l"
SHIORI_UI_SHOW_CURSOR="${SHIORI_UI_ESC}[?25h"
readonly SHIORI_UI_ESC SHIORI_UI_CR SHIORI_UI_RESET SHIORI_UI_BOLD
readonly SHIORI_UI_DIM SHIORI_UI_CLEAR SHIORI_UI_CLEAR_LINE
readonly SHIORI_UI_HIDE_CURSOR SHIORI_UI_SHOW_CURSOR

shiori_installer_is_animated_terminal() {
  if [ "${SHIORI_INSTALLER_FORCE_ANIMATION:-0}" = 1 ]; then
    return 0
  fi
  [ -t 1 ] && [ "${TERM:-}" != dumb ]
}

shiori_installer_supports_unicode() {
  shiori_ui_locale="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}"
  case "$shiori_ui_locale" in
    *UTF-8*|*utf-8*|*UTF8*|*utf8*) return 0 ;;
  esac
  case "${TERM_PROGRAM:-}" in
    Apple_Terminal|iTerm.app|vscode|WezTerm|ghostty) return 0 ;;
  esac
  return 1
}

shiori_installer_set_brand_blue() {
  case "${COLORTERM:-}" in
    truecolor|24bit) SHIORI_UI_BRAND_BLUE="${SHIORI_UI_ESC}[38;2;51;136;187m" ;;
    *)
      case "${TERM:-}" in
        *256color*) SHIORI_UI_BRAND_BLUE="${SHIORI_UI_ESC}[38;5;67m" ;;
        *) SHIORI_UI_BRAND_BLUE="${SHIORI_UI_ESC}[34m" ;;
      esac
      ;;
  esac
}

shiori_installer_sleep() {
  [ "${SHIORI_INSTALLER_NO_SLEEP:-0}" = 1 ] || sleep "$1"
}

# The production app mark, rasterized from shiori-icon-source.png at 34 x 32
# logical pixels. Upper/lower half blocks preserve twice the vertical detail of
# the old square grid without making the installer take over the terminal.
shiori_installer_set_logo_row() {
  case "$1" in
    0) SHIORI_UI_LOGO_ROW='   ▄▄▄▄▄▄▄▄▄▄███  ▄▄▄▄▄▄▄▄▄▄███' ;;
    1) SHIORI_UI_LOGO_ROW='         ██            ██' ;;
    2) SHIORI_UI_LOGO_ROW='         ██   ▄        ██    ▄' ;;
    3) SHIORI_UI_LOGO_ROW='  ▄▄▄▄▄▄▄██▄▄███▄▄▄▄▄▄▄██▄▄▄███▄' ;;
    4) SHIORI_UI_LOGO_ROW='   ▀    ▀██       ▀    ██' ;;
    5) SHIORI_UI_LOGO_ROW='         ██            ██' ;;
    6) SHIORI_UI_LOGO_ROW='        ███            ██' ;;
    7) SHIORI_UI_LOGO_ROW='        ▀█▀     ██▄    █▀' ;;
    8) SHIORI_UI_LOGO_ROW='                ██          ▄█▄▄' ;;
    9) SHIORI_UI_LOGO_ROW='  ██▀▀▀▀▀▀▀▀▀███████▀▀▀▀▀▀▀▀▀▀▀▀' ;;
    10) SHIORI_UI_LOGO_ROW='            ▄██▀██ ▀▄' ;;
    11) SHIORI_UI_LOGO_ROW='          ▄██▀  ██   ██▄' ;;
    12) SHIORI_UI_LOGO_ROW='        ▄██▀    ██    ▀▀██▄▄' ;;
    13) SHIORI_UI_LOGO_ROW='     ▄▄▀▀       ██       ▀████▄▄' ;;
    14) SHIORI_UI_LOGO_ROW='  ▄▀▀▀          ██          ▀▀█▀' ;;
    15) SHIORI_UI_LOGO_ROW='                ▀▀' ;;
    *) SHIORI_UI_LOGO_ROW='' ;;
  esac
}

shiori_installer_draw_logo_frame() {
  shiori_ui_settled_radius="$1"
  shiori_ui_active_radius="$2"
  shiori_ui_flash="$3"
  shiori_ui_show_name="$4"
  shiori_installer_set_brand_blue
  shiori_ui_blue="$SHIORI_UI_BRAND_BLUE"
  shiori_ui_frame="$SHIORI_UI_CLEAR"
  shiori_ui_y=0

  while [ "$shiori_ui_y" -le 15 ]; do
    shiori_installer_set_logo_row "$shiori_ui_y"
    shiori_ui_row="$SHIORI_UI_LOGO_ROW"
    shiori_ui_distance=$((shiori_ui_y - 9))
    [ "$shiori_ui_distance" -lt 0 ] && shiori_ui_distance=$((-shiori_ui_distance))

    if [ "$shiori_ui_flash" = 1 ]; then
      shiori_ui_frame="${shiori_ui_frame}    ${SHIORI_UI_BOLD}${SHIORI_UI_ESC}[39m${shiori_ui_row}${SHIORI_UI_RESET}\n"
    elif [ "$shiori_ui_distance" -le "$shiori_ui_settled_radius" ]; then
      shiori_ui_frame="${shiori_ui_frame}    ${shiori_ui_blue}${shiori_ui_row}${SHIORI_UI_RESET}\n"
    elif [ "$shiori_ui_distance" -eq "$shiori_ui_active_radius" ]; then
      shiori_ui_frame="${shiori_ui_frame}    ${SHIORI_UI_BOLD}${SHIORI_UI_ESC}[39m${shiori_ui_row}${SHIORI_UI_RESET}\n"
    else
      shiori_ui_frame="${shiori_ui_frame}\n"
    fi
    shiori_ui_y=$((shiori_ui_y + 1))
  done

  if [ "$shiori_ui_show_name" = 1 ]; then
    shiori_ui_frame="${shiori_ui_frame}\n                ${SHIORI_UI_BOLD}${shiori_ui_blue}Shiori CLI${SHIORI_UI_RESET}\n"
  fi
  printf '%b' "$shiori_ui_frame"
}

shiori_installer_print_static_logo() {
  if ! shiori_installer_is_animated_terminal; then
    if shiori_installer_supports_unicode; then
      printf '\n  栞  Shiori CLI\n\n'
    else
      printf '\n  SHIORI CLI\n\n'
    fi
    return
  fi

  shiori_installer_set_brand_blue
  shiori_ui_blue="$SHIORI_UI_BRAND_BLUE"
  if shiori_installer_supports_unicode; then
    printf '\n  %s栞%s  %sShiori CLI%s\n\n' \
      "$shiori_ui_blue" "$SHIORI_UI_RESET" "$SHIORI_UI_BOLD" "$SHIORI_UI_RESET"
  else
    printf '\n  %sSHIORI CLI%s\n\n' "$SHIORI_UI_BOLD" "$SHIORI_UI_RESET"
  fi
}

shiori_installer_logo_animation() {
  if ! shiori_installer_is_animated_terminal || ! shiori_installer_supports_unicode; then
    shiori_installer_print_static_logo
    return
  fi

  printf '%s%s' "$SHIORI_UI_HIDE_CURSOR" "$SHIORI_UI_CLEAR"
  trap 'printf "%s%s\n" "$SHIORI_UI_RESET" "$SHIORI_UI_SHOW_CURSOR"; trap - INT TERM HUP; exit 130' INT TERM HUP

  # Expand from the main horizontal stroke in both directions. The bright
  # leading rows read like fresh ink; settled rows cool into Shiori blue.
  shiori_ui_radius=0
  while [ "$shiori_ui_radius" -le 9 ]; do
    shiori_installer_draw_logo_frame \
      $((shiori_ui_radius - 1)) "$shiori_ui_radius" 0 0
    shiori_installer_sleep 0.095
    shiori_ui_radius=$((shiori_ui_radius + 1))
  done

  shiori_installer_draw_logo_frame 9 99 0 0
  shiori_installer_sleep 0.20
  shiori_installer_draw_logo_frame 9 99 1 0
  shiori_installer_sleep 0.10
  shiori_installer_draw_logo_frame 9 99 0 0
  shiori_installer_sleep 0.10
  shiori_installer_draw_logo_frame 9 99 1 0
  shiori_installer_sleep 0.10
  shiori_installer_draw_logo_frame 9 99 0 1
  shiori_installer_sleep 0.35

  printf '%s%s\n' "$SHIORI_UI_RESET" "$SHIORI_UI_SHOW_CURSOR"
  trap - INT TERM HUP
}

shiori_installer_quote_animation() {
  if ! shiori_installer_supports_unicode; then
    return
  fi

  if ! shiori_installer_is_animated_terminal; then
    printf '  “普通”とか“あたりまえ”って なんだろう\n'
    printf '    — 「栞」 / MyGO!!!!!\n\n'
    return
  fi

  shiori_installer_set_brand_blue
  shiori_ui_blue="$SHIORI_UI_BRAND_BLUE"
  printf '%s' "$SHIORI_UI_HIDE_CURSOR"
  trap 'printf "%s%s\n" "$SHIORI_UI_RESET" "$SHIORI_UI_SHOW_CURSOR"; trap - INT TERM HUP; exit 130' INT TERM HUP

  printf '\n'
  shiori_installer_sleep 0.16
  printf '    %s▎%s  %s“普通”とか“あたりまえ”って%s\n' \
    "$shiori_ui_blue" "$SHIORI_UI_RESET" "$SHIORI_UI_DIM" "$SHIORI_UI_RESET"
  shiori_installer_sleep 0.30
  printf '    %s▎%s  %sなんだろう%s\n' \
    "$shiori_ui_blue" "$SHIORI_UI_RESET" "$SHIORI_UI_BOLD" "$SHIORI_UI_RESET"
  shiori_installer_sleep 0.34
  printf '          %s— 「栞」 / MyGO!!!!!%s\n\n' \
    "$SHIORI_UI_DIM" "$SHIORI_UI_RESET"
  shiori_installer_sleep 0.50

  printf '%s%s' "$SHIORI_UI_RESET" "$SHIORI_UI_SHOW_CURSOR"
  trap - INT TERM HUP
}

shiori_installer_spinner_frame() {
  shiori_ui_spinner_step="$1"
  if shiori_installer_supports_unicode; then
    case $((shiori_ui_spinner_step % 10)) in
      0) printf '⠋' ;; 1) printf '⠙' ;; 2) printf '⠹' ;; 3) printf '⠸' ;;
      4) printf '⠼' ;; 5) printf '⠴' ;; 6) printf '⠦' ;; 7) printf '⠧' ;;
      8) printf '⠇' ;; *) printf '⠏' ;;
    esac
  else
    case $((shiori_ui_spinner_step % 4)) in
      0) printf '-' ;; 1) printf '\\' ;; 2) printf '|' ;; *) printf '/' ;;
    esac
  fi
}

shiori_installer_progress_label() {
  shiori_ui_log_file="$1"
  shiori_ui_label="$2"
  while IFS= read -r shiori_ui_line; do
    case "$shiori_ui_line" in
      Resolving\ *) shiori_ui_label="${shiori_ui_line#Resolving }" ;;
      Downloading\ *) shiori_ui_label="${shiori_ui_line#Downloading }" ;;
      Verifying\ *) shiori_ui_label="${shiori_ui_line#Verifying }" ;;
      Extracting\ *) shiori_ui_label="${shiori_ui_line#Extracting }" ;;
      Installing\ *) shiori_ui_label="${shiori_ui_line#Installing }" ;;
      Linking\ *) shiori_ui_label="${shiori_ui_line#Linking }" ;;
    esac
  done < "$shiori_ui_log_file"
  if [ "${#shiori_ui_label}" -gt 58 ]; then
    shiori_ui_label=$(printf '%.55s...' "$shiori_ui_label")
  fi
  printf '%s' "$shiori_ui_label"
}

shiori_installer_draw_progress() {
  shiori_ui_step="$1"
  shiori_ui_title="$2"
  shiori_ui_label="$3"
  shiori_installer_set_brand_blue
  shiori_ui_blue="$SHIORI_UI_BRAND_BLUE"
  shiori_ui_spinner=$(shiori_installer_spinner_frame "$shiori_ui_step")
  if shiori_installer_supports_unicode; then
    shiori_ui_full='█'
    shiori_ui_empty='░'
  else
    shiori_ui_full='#'
    shiori_ui_empty='-'
  fi

  shiori_ui_width=28
  shiori_ui_trail=8
  shiori_ui_head=$((shiori_ui_step % (shiori_ui_width + shiori_ui_trail)))
  shiori_ui_bar=''
  shiori_ui_index=0
  while [ "$shiori_ui_index" -lt "$shiori_ui_width" ]; do
    shiori_ui_age=$((shiori_ui_head - shiori_ui_index))
    if [ "$shiori_ui_age" -ge 0 ] && [ "$shiori_ui_age" -lt "$shiori_ui_trail" ]; then
      case "$shiori_ui_age" in
        0) shiori_ui_cell="${SHIORI_UI_BOLD}${SHIORI_UI_ESC}[39m${shiori_ui_full}${SHIORI_UI_RESET}" ;;
        1|2) shiori_ui_cell="${SHIORI_UI_BOLD}${shiori_ui_blue}${shiori_ui_full}${SHIORI_UI_RESET}" ;;
        3|4|5) shiori_ui_cell="${shiori_ui_blue}${shiori_ui_full}${SHIORI_UI_RESET}" ;;
        *) shiori_ui_cell="${SHIORI_UI_DIM}${shiori_ui_blue}${shiori_ui_full}${SHIORI_UI_RESET}" ;;
      esac
    else
      shiori_ui_cell="${SHIORI_UI_DIM}${shiori_ui_empty}${SHIORI_UI_RESET}"
    fi
    shiori_ui_bar="${shiori_ui_bar}${shiori_ui_cell}"
    shiori_ui_index=$((shiori_ui_index + 1))
  done

  printf '%s%s  %s%s%s %s %s%s%s  %s' \
    "$SHIORI_UI_CR" "$SHIORI_UI_CLEAR_LINE" \
    "$shiori_ui_blue" "$shiori_ui_spinner" "$SHIORI_UI_RESET" \
    "$shiori_ui_bar" "$SHIORI_UI_BOLD" "$shiori_ui_title" \
    "$SHIORI_UI_RESET" "$shiori_ui_label"
}

shiori_installer_finish_progress() {
  printf '%s%s%s' "$SHIORI_UI_CR" "$SHIORI_UI_CLEAR_LINE" "$SHIORI_UI_SHOW_CURSOR"
}

shiori_installer_run_with_progress() {
  shiori_ui_title="$1"
  shift

  if ! shiori_installer_is_animated_terminal; then
    printf '%s...\n' "$shiori_ui_title"
    if "$@"; then
      shiori_ui_status=0
    else
      shiori_ui_status=$?
    fi
    if [ "$shiori_ui_status" -eq 0 ]; then
      printf 'ok  %s complete\n' "$shiori_ui_title"
    fi
    return "$shiori_ui_status"
  fi

  shiori_ui_log_file="${TMPDIR:-/tmp}/shiori-cli-installer.$$"
  rm -f "$shiori_ui_log_file"
  : > "$shiori_ui_log_file"
  ("$@") > "$shiori_ui_log_file" 2>&1 &
  shiori_ui_task_pid=$!

  printf '%s' "$SHIORI_UI_HIDE_CURSOR"
  trap 'kill "$shiori_ui_task_pid" 2>/dev/null || true; shiori_installer_finish_progress; rm -f "$shiori_ui_log_file"; trap - INT TERM HUP; exit 130' INT TERM HUP

  shiori_ui_step=0
  shiori_ui_label='starting'
  while kill -0 "$shiori_ui_task_pid" 2>/dev/null; do
    if [ $((shiori_ui_step % 5)) -eq 0 ]; then
      shiori_ui_label=$(shiori_installer_progress_label "$shiori_ui_log_file" "$shiori_ui_label")
    fi
    shiori_installer_draw_progress "$shiori_ui_step" "$shiori_ui_title" "$shiori_ui_label"
    shiori_ui_step=$((shiori_ui_step + 1))
    shiori_installer_sleep 0.08
  done

  if wait "$shiori_ui_task_pid"; then
    shiori_ui_status=0
  else
    shiori_ui_status=$?
  fi
  shiori_installer_finish_progress
  trap - INT TERM HUP

  if [ "$shiori_ui_status" -ne 0 ]; then
    printf '%s failed\n\n' "$shiori_ui_title" >&2
    cat "$shiori_ui_log_file" >&2
    rm -f "$shiori_ui_log_file"
    return "$shiori_ui_status"
  fi

  rm -f "$shiori_ui_log_file"
  shiori_installer_set_brand_blue
  shiori_ui_blue="$SHIORI_UI_BRAND_BLUE"
  if shiori_installer_supports_unicode; then
    printf '  %s✓%s %s complete\n' "$shiori_ui_blue" "$SHIORI_UI_RESET" "$shiori_ui_title"
  else
    printf '  ok %s complete\n' "$shiori_ui_title"
  fi
}
