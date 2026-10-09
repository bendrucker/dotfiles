#!/usr/bin/env bash

set -e

cd "$(dirname "$0")"

# shellcheck source=../scripts/shell/git-sync.sh
. ../scripts/shell/git-sync.sh

# The pinned catppuccin flavors are listed in package.toml. ya clones each from
# https://github.com/<owner>/<repo>, which an org's insteadOf rule can send back
# to SSH, and SSH cannot sign while the Mac is locked.
if command -v ya >/dev/null 2>&1; then
  repos=()
  while IFS= read -r repo; do
    repos+=("$repo")
  done < <(sed -nE 's|^use = "([^/"]+/[^:/"]+).*|\1|p' yazi-package.toml | sort -u)
  (git_https_env "${repos[@]}" && ya pkg install >/dev/null)
fi
