#!/usr/bin/env sh

if [ -f /opt/homebrew/opt/asdf/libexec/asdf.sh ]; then
  # shellcheck disable=SC1091
  . /opt/homebrew/opt/asdf/libexec/asdf.sh
else
  echo "asdf not found, tools will not be available" >&2
fi
