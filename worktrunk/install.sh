#!/usr/bin/env zsh
#
# Install worktrunk-sync from crates.io.
# Provides `wt-sync` and the `wt sync` external subcommand for stack rebases.

set -e

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found; skipping worktrunk-sync install" >&2
  exit 0
fi

echo "› cargo install worktrunk-sync"
cargo install worktrunk-sync
