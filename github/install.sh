#!/usr/bin/env zsh
#
# Reconcile installed gh CLI extensions against extensions.conf.

set -e

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
  gh extension install --force --pin "$tag" "$repo"

  if [[ -d "$dir/.git" ]]; then
    git -C "$dir" fetch --tags --quiet origin
    git -C "$dir" -c advice.detachedHead=false checkout --quiet "refs/tags/$tag"
  fi
}

for repo in ${(k)desired}; do
  install_extension "$repo" "$desired[$repo]"
done

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
  gum spin --title "Removing gh-$name" -- gh extension remove "$name"
done <<< "$to_remove"
