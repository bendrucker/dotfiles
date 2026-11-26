#!/usr/bin/env bash
#
# Install or upgrade terminal-browser, then point its agent skills at the
# installed version. An upgrade stops any browser that is running.

set -eo pipefail

# Each install downloads about 140 MB, which CI's bootstrap would pay three times.
if [[ -n "${CI:-}" ]]; then
  exit 0
fi

bin="${XDG_BIN_HOME:-$HOME/.local/bin}/terminal-browser"

if [[ ! -x "$bin" ]]; then
  echo "› installing terminal-browser"
  curl --fail --silent --show-error --location https://terminal-browser.sh/install | bash ||
    echo "✗ terminal-browser install failed" >&2
elif ! "$bin" upgrade </dev/null; then
  echo "✗ terminal-browser upgrade failed" >&2
fi

if [[ -x "$bin" ]]; then
  "$bin" setup </dev/null || echo "✗ terminal-browser setup failed" >&2
fi
