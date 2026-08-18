#!/usr/bin/env bash
#
# Nudge a running Ghostty to re-read ~/.config/ghostty/config. SIGUSR2 is the
# same path as its reload_config keybind, so open windows, tabs, and the shells
# in them keep running.
#
# Ghostty is the only thing this topic installs that holds its config in
# memory. yazi reads its theme at startup, and zoxide's config is environment
# variables in a shell that already has them.
set -uo pipefail

# pkill exits 1 with nothing to signal, which is every machine without Ghostty
# running, CI included.
pkill -USR2 -x ghostty 2>/dev/null || true
