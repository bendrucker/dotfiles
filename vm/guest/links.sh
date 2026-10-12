#!/bin/bash
#
# Prints every link the installer may lay, one "path -> target" per line, so
# two snapshots taken around a second install diff to what it changed.

set -euo pipefail

{
  find "$HOME" -maxdepth 1 -type l
  [ -d "$HOME/.config" ] && find "$HOME/.config" -type l
} | sort | while IFS= read -r link; do
  printf '%s -> %s\n' "$link" "$(readlink "$link")"
done
