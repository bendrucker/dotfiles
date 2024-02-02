#!/usr/bin/env zsh

asdf="${HOMEBREW_PREFIX}/opt/asdf/libexec/asdf.sh"

if [ -f "$asdf" ]; then
  source "${asdf}"
else
  echo "asdf not found, tools will not be available" >&2
fi
