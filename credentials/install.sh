#!/usr/bin/env bash

set -e

# Tighten the modes of the credential files this repo knows how to name. The
# audit's reporting half runs from bin/dotfiles-upgrade instead, so an install
# stays offline and prompts for nothing.
exec "$(dirname "$0")/bin/credential-audit" --enforce
