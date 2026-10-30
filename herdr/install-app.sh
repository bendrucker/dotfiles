#!/usr/bin/env zsh
#
# Install the Herdr app and herdr-core (hc), the server its terminals run in,
# and update hc. The app updates itself, so this only installs it.

set -e
set -o pipefail

if [[ -n "${CI:-}" ]]; then
  exit 0
fi

releases=https://releases.herdr.dev

# hc is only a link the installer makes when no other hc is on PATH.
export HC_INSTALL_DIR="${HC_INSTALL_DIR:-$HOME/.local/bin}"
core="$HC_INSTALL_DIR/herdr-core"

# hc update swaps the binary and restarts the core while its terminals keep
# running. Closed stdin keeps it from waiting on anything.
if [[ -x "$core" ]]; then
  "$core" update </dev/null || echo "✗ hc update did not finish" >&2
else
  echo "› installing herdr-core to $HC_INSTALL_DIR"
  curl --fail --silent --show-error --location "$releases/core/install.sh" | sh ||
    echo "✗ herdr-core install failed" >&2
fi

if [[ "$(uname -s)" != Darwin ]]; then
  exit 0
fi

if [[ ! -d "$HOME/Applications/Herdr.app" && ! -d /Applications/Herdr.app ]]; then
  echo "› installing the Herdr app to ~/Applications"
  curl --fail --silent --show-error --location "$releases/app/install.sh" | sh ||
    echo "✗ Herdr app install failed" >&2
fi

exit 0
