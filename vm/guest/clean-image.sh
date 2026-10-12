#!/bin/bash
#
# Prepares the vanilla Cirrus image for vm-test, over SSH as admin with
# passwordless sudo already granted. It adds what a fresh Mac's owner would
# have before running scripts/setup (the Command Line Tools, for git) and the
# Tart guest agent that `tart exec` talks to, and leaves Homebrew absent.
#
# Usage: clean-image.sh

set -euo pipefail

agent_version=0.10.0
agent_sha256=303a50d452753e36776ce8775e243be580bb3fc3ec8efde154320c37fd65b1a7

# tart set --disk-size leaves the new space unallocated, after the gap the
# dropped Recovery partition left. The repair moves the backup GPT to the new
# end of the disk, and the resize hands the APFS container all of it.
echo y | sudo diskutil repairDisk disk0
sudo diskutil apfs resizeContainer disk0s2 0

# softwareupdate lists the Command Line Tools only while this marker exists,
# the same trick Homebrew's installer uses.
if ! xcode-select --print-path >/dev/null 2>&1; then
  marker=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  touch "$marker"
  label=$(softwareupdate --list 2>/dev/null |
    sed -n 's/^[[:space:]]*\* Label: \(Command Line Tools.*\)$/\1/p' |
    sort -V | tail -n 1)
  [ -n "$label" ] || { echo "no Command Line Tools in softwareupdate --list" >&2; exit 1; }
  sudo softwareupdate --install "$label" --verbose
  rm -f "$marker"
fi

archive=$(mktemp -d)/agent.tar.gz
curl -fsSL -o "$archive" \
  "https://github.com/cirruslabs/tart-guest-agent/releases/download/v$agent_version/tart-guest-agent-darwin-all.tar.gz"
echo "$agent_sha256  $archive" | shasum -a 256 -c -
sudo mkdir -p /usr/local/bin
sudo tar -xzf "$archive" -C /usr/local/bin tart-guest-agent

# A global agent runs in the logged-in user's GUI session, so whatever
# `tart exec` starts lands in gui/501 rather than the system domain.
plist() {
  local label=$1 flag=$2 dir=$3
  sudo tee "$dir/$label.plist" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/tart-guest-agent</string><string>$flag</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/$label.log</string>
  <key>StandardErrorPath</key><string>/tmp/$label.log</string>
</dict>
</plist>
PLIST
}
plist org.cirruslabs.tart-guest-agent --run-agent /Library/LaunchAgents
plist org.cirruslabs.tart-guest-daemon --run-daemon /Library/LaunchDaemons
