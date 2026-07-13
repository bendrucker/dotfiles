#!/usr/bin/env bash

set -e

# ActivityWatch ships as an Intel-only cask and its data dir and permission
# grants are macOS-specific. Nothing to do elsewhere.
if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

# aw-server-rust creates the SQLite db here on first launch. Pre-creating the
# parent means the LaunchAgent's first run has somewhere to write immediately.
mkdir -p "$HOME/Library/Application Support/activitywatch"

# The cask binary is Intel-only, so an arm64 host needs Rosetta 2 to run aw-qt.
# Installing it agrees to a license and can prompt, so skip under NONINTERACTIVE
# (the nightly upgrade) and let the interactive install handle it.
if [ "$(uname -m)" = "arm64" ] && ! /usr/bin/arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
  if [[ -n "${NONINTERACTIVE-}" ]]; then
    gum log --level warn "Rosetta 2 missing; run: softwareupdate --install-rosetta --agree-to-license"
  else
    gum log --level info "installing Rosetta 2 (ActivityWatch is Intel-only)"
    softwareupdate --install-rosetta --agree-to-license
  fi
fi

# TCC forbids scripting these grants. aw-watcher-window reads window titles
# through the Accessibility API, and the permission prompt only fires when
# aw-qt is first launched from an already-granted terminal
# (ActivityWatch/activitywatch#376). After this one-time setup, the
# com.user.activitywatch LaunchAgent supervises autostart on every login.
if [[ -z "${NONINTERACTIVE-}" ]]; then
  gum log --level info "ActivityWatch one-time setup (TCC cannot automate these):"
  gum log --level info "  1. Grant Accessibility to ActivityWatch: System Settings > Privacy & Security > Accessibility (window titles need it)"
  gum log --level info "  2. Launch it once from this terminal so the prompt fires: open -a ActivityWatch"
fi
