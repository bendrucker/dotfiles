#!/usr/bin/env bash

publish () {
  git fetch
  if [[ $(git rev-parse HEAD) != $(git rev-parse "@{u}") ]]; then
    return 1
  fi
  npm version "$1"
  git push origin master --follow-tags
  npm publish
}

module () {
  cd "$PROJECTS" || exit 1
  mkdir "$1"
  cd "$1" || exit 1
  git init
  hub create
  travis enable --no-interactive > /dev/null &
  yo bd
}