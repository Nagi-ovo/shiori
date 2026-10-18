#!/usr/bin/env sh
# Source this before Cargo-based release builds. It remaps local source paths
# out of Rust binaries without hardcoding developer machine paths in Git.

if [ -z "${SHIORI_REPO_ROOT:-}" ]; then
  shiori_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  SHIORI_REPO_ROOT=$(CDPATH= cd -- "$shiori_script_dir/.." && pwd)
fi

shiori_sep=$(printf '\037')
shiori_remap_flags="--remap-path-prefix=$HOME/.cargo/registry=/cargo/registry${shiori_sep}--remap-path-prefix=$HOME/.cargo/git=/cargo/git${shiori_sep}--remap-path-prefix=$SHIORI_REPO_ROOT=/shiori"

case "${CARGO_ENCODED_RUSTFLAGS:-}" in
  *"--remap-path-prefix=$SHIORI_REPO_ROOT=/shiori"*) ;;
  "")
    export CARGO_ENCODED_RUSTFLAGS="$shiori_remap_flags"
    ;;
  *)
    export CARGO_ENCODED_RUSTFLAGS="${CARGO_ENCODED_RUSTFLAGS}${shiori_sep}${shiori_remap_flags}"
    ;;
esac

unset shiori_remap_flags shiori_script_dir shiori_sep
