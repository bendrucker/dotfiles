#!/usr/bin/env bash
# Seed the fzf opts cache so FZF_DEFAULT_OPTS_FILE resolves to a real file
# before the theme-sync watcher's first run.
set -euo pipefail

bin_dir="$(cd "$(dirname "$0")" && pwd)/bin"
"$bin_dir/theme-sync-fzf"
