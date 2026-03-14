#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.config/nvim"

if [[ -L "$TARGET" ]] && [[ "$(readlink "$TARGET")" == "$SCRIPT_DIR/config" ]]; then
  exit 0
fi

mkdir -p "$(dirname "$TARGET")"
ln -sfn "$SCRIPT_DIR/config" "$TARGET"
echo "  ✓ ~/.config/nvim"
