#!/bin/bash
set -e

[[ "$(uname -s)" == "Darwin" ]] || exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Install theme-sync daemon
"$SCRIPT_DIR/theme-sync/install.sh"
