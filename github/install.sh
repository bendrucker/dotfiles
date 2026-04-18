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
while read -r repo version; do
  [[ -z "$repo" || "$repo" == \#* ]] && continue
  desired[$repo]=$version
done < extensions.conf

# Binary extensions (release tag has compiled assets) install cleanly via
# `gh extension install --pin <tag>`. Script extensions (git clone + checkout)
# hit a gh bug where `--pin` is ignored and origin/HEAD is checked out
# regardless; force the tag via git for those.
install_extension() {
  local repo=$1 tag=$2 assets dir
  assets=$(gh release view "$tag" --repo "$repo" --json assets --jq '.assets | length' 2>/dev/null) || assets=0
  dir=$HOME/.local/share/gh/extensions/${repo##*/}

  echo "→ $repo @ $tag"
  if (( assets > 0 )); then
    gh extension install --force --pin "$tag" "$repo"
    return
  fi

  if [[ ! -d "$dir/.git" ]]; then
    gh extension install "$repo" >/dev/null
  fi
  git -C "$dir" fetch --tags --quiet origin
  git -C "$dir" -c advice.detachedHead=false checkout --quiet "refs/tags/$tag"
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

for repo in "${undeclared[@]}"; do
  name=${${repo##*/}#gh-}
  if [[ "$force" == true ]]; then
    gh extension remove "$name"
  else
    read -r "reply?Remove gh-$name? [y/N] "
    [[ "$reply" == [Yy]* ]] && gh extension remove "$name"
  fi
done
