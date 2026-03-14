#!/usr/bin/env sh
set -e
TOPIC_DIR="$(cd "$(dirname "$0")" && pwd)"
GIT_CONFIG="$HOME/.config/git"
mkdir -p "$GIT_CONFIG"
ln -sf "$TOPIC_DIR/config" "$GIT_CONFIG/config"
ln -sf "$TOPIC_DIR/ignore" "$GIT_CONFIG/ignore"
# Link local config if it exists in the topic dir
[ -f "$TOPIC_DIR/config.local" ] && ln -sf "$TOPIC_DIR/config.local" "$GIT_CONFIG/config.local"
