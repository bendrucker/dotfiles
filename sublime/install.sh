#!/usr/bin/env sh

set -euf

PACKAGE_CONTROL_URL="https://packagecontrol.io/Package%20Control.sublime-package"
DATA="$HOME/Library/Application Support/Sublime Text 3"
PACKAGES="$DATA/Installed Packages"
PACKAGE_CONTROL_PATH="$PACKAGES/Package Control.sublime-package"
SETTINGS="$DATA/Packages/User"


mkdir -p "$DATA"
mkdir -p "$PACKAGES"

[ -f "$PACKAGE_CONTROL_PATH" ] || curl --silent "$PACKAGE_CONTROL_URL" > "$PACKAGE_CONTROL_PATH"
ln -fs "$ZSH/sublime/packages.json" "$SETTINGS/Package Control.sublime-settings"
