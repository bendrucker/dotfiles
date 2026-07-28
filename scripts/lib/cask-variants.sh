#!/usr/bin/env sh
# Selection logic for install-cask-variants, kept separate so it can be tested
# without a Homebrew installation.

# Print the installed casks that a declared sibling variant supersedes, as
# `installed<TAB>declared` pairs. Both arguments are newline-separated lists of
# cask tokens.
#
# Homebrew names app variants with an @suffix: ghostty@tip, claude-code@latest,
# iterm2@beta. A cask is superseded when it is no longer declared but some other
# variant of the same app is.
cask_variants_superseded() {
  cask_variants_declared="$1"
  cask_variants_installed="$2"

  printf '%s\n' "$cask_variants_installed" | while IFS= read -r installed; do
    [ -n "$installed" ] || continue

    if printf '%s\n' "$cask_variants_declared" | grep -qxF "$installed"; then
      continue
    fi

    for declared in $cask_variants_declared; do
      if [ "${declared%%@*}" = "${installed%%@*}" ]; then
        printf '%s\t%s\n' "$installed" "$declared"
        break
      fi
    done
  done
}
