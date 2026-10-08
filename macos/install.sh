#!/usr/bin/env bash

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

shopt -s extglob

if ! mise bootstrap --only macos-defaults --yes; then
  gum log --level error "mise bootstrap could not apply the macOS defaults"
  defaults_failed=1
fi

for file in "$ZSH"/macos/!(install).sh
do
  bash "$file"
done

# LaunchAgents are declared in the topic mise.toml fragments, and
# mise/miserc.toml.tera selects which of them apply on this machine.
if ! mise bootstrap --only macos-launchd-agents --yes; then
  gum log --level error "mise bootstrap could not apply the LaunchAgents"
  launchd_failed=1
fi

# Exit nonzero if the defaults or the agents failed, so the failure is not
# swallowed by a zero exit. Each was already logged above.
exit $(( ${launchd_failed:-0} || ${defaults_failed:-0} ))
