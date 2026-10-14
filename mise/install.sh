#!/usr/bin/env zsh
#
# Install mise tools and activate shims for subsequent installers.

set -e

cd "$(dirname "$0")"/..

# Each topic's file reaches mise through a conf.d link, and install-symlinks
# lays those after this runs. Installing from inside each topic directory finds
# the file without its link, so a tool new to this run is on disk before a
# migration removes the Homebrew copy it replaces.
# Every file is trusted, so a shell inside a topic directory reads it as
# project config without a prompt. Most declare only [dotfiles] or [bootstrap]
# and have nothing to install.
echo "› mise install"
typeset -A repair_checked
for file in */mise.toml */mise.*.toml(N); do
  mise trust "$file" --yes 2>/dev/null
  [[ $file == */mise.toml ]] && grep -q '^\[tools' "$file" || continue
  (cd "${file:h}" && mise install)
  # mise finds an install's executables through the registry metadata built
  # into it, and an upgrade can move where that metadata looks. `mise install`
  # still counts the old install as present, so no shim is made for it.
  mise --cd "${file:h}" ls --current --installed --no-header | while read -r tool version _; do
    [[ -n ${repair_checked[$tool@$version]} ]] && continue
    repair_checked[$tool@$version]=1
    [[ -n $(mise --cd "${file:h}" bin-paths "$tool@$version" 2>/dev/null) ]] ||
      mise --cd "${file:h}" install --force "$tool@$version"
  done
done

# Activate mise shims so that installers can use any shell
eval "$(mise activate --shims)"
