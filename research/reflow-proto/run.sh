#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi
mkdir -p tmp artifacts
bun extract.ts > tmp/lines.txt
python3 prepare.py
cargo build --release --locked
./target/release/shiori-reflow-proto
cargo metadata --format-version 1 --locked > tmp/cargo-metadata.json
python3 report.py
cargo fmt -- --check
cargo clippy --locked -- -D warnings
