publish () {
  git fetch
  if [[ $(git rev-parse HEAD) != $(git rev-parse @{u}) ]]; then
    return 1
  fi
  npm version $1
  git push origin --follow-tags
  npm publish
}

module () {
  cd $PROJECTS
  mkdir $1
  cd $1
  git init
  hub create
  travis enable --no-interactive &
  yo bd
}
