#!/usr/bin/env sh

asdf="${HOMEBREW_PREFIX}/opt/asdf/libexec/asdf.sh"

if [ -f "$asdf" ]; then
  # shellcheck disable=SC1091
  . "${asdf}"
else
  echo "asdf not found, tools will not be available" >&2
fi
