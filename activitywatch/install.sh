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

# Screen Time syncs each iOS/iPadOS device's app-focus history to this Mac, and
# aw-import-screentime decodes it into ActivityWatch's own buckets so phone and
# tablet usage land in the same db as the Mac's capture.
#
# Pinned to a fork: upstream discovers devices by filtering DevicePeer on
# platform=2, which drops one of this Mac's iPhones (Apple registers identical
# hardware under differing platform values). The fork adds --all-devices, which
# enumerates the synced stream directories instead. Repoint at upstream once
# that lands there.
AW_IMPORT_SCREENTIME_REF="git+https://github.com/bendrucker/aw-import-screentime@6a8d7dcbe18be271adc6d90ac48f20727a684ba0"

if command -v uv >/dev/null 2>&1; then
  uv tool install "$AW_IMPORT_SCREENTIME_REF"
else
  gum log --level warn "uv not found; skipping aw-import-screentime (run scripts/install after mise install)"
fi

# The LaunchAgent runs the importer through /bin/zsh, so zsh is the process TCC
# holds responsible for reading the Biome store.
if [[ -z "${NONINTERACTIVE-}" ]]; then
  gum log --level info "Screen Time import one-time setup:"
  gum log --level info "  Grant Full Disk Access to /bin/zsh: System Settings > Privacy & Security > Full Disk Access (reads ~/Library/Biome)"
fi
