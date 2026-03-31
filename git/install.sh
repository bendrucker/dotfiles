#!/usr/bin/env sh
set -e
TOPIC_DIR="$(cd "$(dirname "$0")" && pwd)"
GIT_CONFIG="$HOME/.config/git"
mkdir -p "$GIT_CONFIG"
[ -f "$TOPIC_DIR/config.local" ] && ln -sf "$TOPIC_DIR/config.local" "$GIT_CONFIG/config.local"
