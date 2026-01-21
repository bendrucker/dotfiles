#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Install theme-sync daemon
"$SCRIPT_DIR/theme-sync/install.sh"
