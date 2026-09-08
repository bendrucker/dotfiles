#!/usr/bin/env zsh
#
# Reconcile installed gh CLI extensions against extensions.conf.

set -e

# Before the cd: ${0:A} resolves against the current directory, so a relative
# $0 would pick up the new one and name a path inside it.
source "${0:A:h}/../scripts/shell/spin.sh"
git_sync_bin="${0:A:h}/../bin/git-sync"

cd "${0:h}"

command -v gh >/dev/null || exit 0

force=false
for arg in "$@"; do
  case "$arg" in
    --force|-f) force=true ;;
  esac
done

typeset -A desired
line_no=0
while read -r repo version _; do
  (( ++line_no ))
  [[ -z "$repo" || "$repo" == \#* ]] && continue
  if [[ -z "$version" ]]; then
    echo "extensions.conf:$line_no: missing version for '$repo'" >&2
    exit 1
  fi
  desired[$repo]=$version
done < extensions.conf

# `gh extension install --pin <tag>` works for binary extensions (downloads
# the tagged release asset) but silently no-ops the pin for script
# extensions, leaving them on origin/HEAD. Detect script extensions by the
# presence of .git under the extension dir and force the pinned tag via git.
install_extension() {
  local repo=$1 tag=$2 data_home dir
  data_home=${XDG_DATA_HOME:-$HOME/.local/share}
  dir=$data_home/gh/extensions/${repo##*/}

  echo "→ $repo @ $tag"

  # gh resolves a script extension's latest version with ls-remote against the
  # clone's own stored remote, which it never re-derives from the current
  # git_protocol setting. One cloned over SSH stays on SSH, where Secretive
  # cannot sign against a locked Mac and the 3am run dies on "agent refused
  # operation".
  if [[ -d "$dir/.git" ]]; then
    "$git_sync_bin" https-remote "$dir" || return 1
  fi

  gh extension install --force --pin "$tag" "$repo" || return 1

  [[ -d "$dir/.git" ]] || return 0
  git -C "$dir" fetch --tags --quiet origin || return 1
  git -C "$dir" -c advice.detachedHead=false checkout --quiet "refs/tags/$tag"
}

# One unreachable extension is not a reason to leave the rest unattempted, or to
# fail an install whose brew, mise, and symlink steps have already succeeded.
failed=()
for repo in ${(k)desired}; do
  install_extension "$repo" "$desired[$repo]" || failed+=("$repo")
done

if (( $#failed > 0 )); then
  {
    echo "WARNING: gh extensions that could not be installed or upgraded:"
    for repo in "${failed[@]}"; do
      echo "  $repo @ $desired[$repo]"
    done
  } >&2
fi

undeclared=()
while IFS=$'\t' read -r _ repo _; do
  [[ -z "$repo" ]] && continue
  (( ${+desired[$repo]} )) && continue
  undeclared+=("$repo")
done < <(gh extension list)

(( $#undeclared == 0 )) && exit 0

if [[ "$force" != true && ( -n "${NONINTERACTIVE-}" || ! -t 0 ) ]]; then
  {
    echo "WARNING: undeclared gh extensions installed:"
    for repo in "${undeclared[@]}"; do
      echo "  $repo"
    done
    echo "Re-run with --force to remove them."
  } >&2
  exit 0
fi

if [[ "$force" == true ]]; then
  to_remove=$(printf '%s\n' "${undeclared[@]}")
else
  to_remove=$(printf '%s\n' "${undeclared[@]}" | \
    gum choose --no-limit \
      --header "Undeclared gh extensions: Tab to select, Enter to confirm")
fi

while IFS= read -r repo; do
  [[ -z "$repo" ]] && continue
  name=${${repo##*/}#gh-}
  spin --title "Removing gh-$name" -- gh extension remove "$name"
done <<< "$to_remove"
