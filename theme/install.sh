#!/usr/bin/env bash
# Seed the theme caches so they resolve to real files before the theme-sync
# watcher's first run: fzf's opts file (FZF_DEFAULT_OPTS_FILE) and the flavor
# cache the pure prompt reads on its first prompt.
set -euo pipefail

bin_dir="$(cd "$(dirname "$0")" && pwd)/bin"
"$bin_dir/theme-sync-fzf"
"$bin_dir/theme-sync-pure"
