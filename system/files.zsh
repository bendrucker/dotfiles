# c my-pkg => cd ~/src/my-pkg

c () {
  cd "$PROJECTS/$1"
}

compdef _files -W $PROJECTS -/ c