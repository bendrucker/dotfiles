# clone in $PROJECTS
# uses personal GH user by default

clone () {
  if [[ $# -eq 0 ]]; then
    echo "clone <repo>          clones $GITHUB_USERNAME/<repo>" >&2
    echo "clone <user>/<repo>   clones <user>/<repo>" >&2
    return 1
  fi

  local repo
  [[ "$1" == *\/* ]] && repo="$1" || repo="$GITHUB_USERNAME/$1"

  cd "$PROJECTS"
  hub clone "$repo" && cd $(cut -d / -f2 <<< "$repo")
}
