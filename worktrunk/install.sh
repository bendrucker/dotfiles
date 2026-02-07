#!/usr/bin/env sh

set -e

TOPIC_DIR="$(cd "$(dirname "$0")" && pwd)"

WORKTRUNK_CONFIG="$HOME/.config/worktrunk"
mkdir -p "$WORKTRUNK_CONFIG"
ln -sf "$TOPIC_DIR/config.toml" "$WORKTRUNK_CONFIG/config.toml"
