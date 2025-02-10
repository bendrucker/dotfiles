#!/usr/bin/env sh

FILENAME="config.toml"
SOURCE="$(cd "$(dirname "$0")" && pwd)"
DESTINATION="$HOME/.config/mise"

mkdir -p "$DESTINATION"
ln -sf "$SOURCE/$FILENAME" "$DESTINATION/$FILENAME"