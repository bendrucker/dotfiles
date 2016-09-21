# urls: droplr http://web.site
# files: droplr file.txt

droplr() {
  if [[ $# -eq 0 ]]; then
    echo 'droplr <url|file>' >&2
    return 1
  fi

  if [[ "$1" =~ ^http[s]?:// ]]; then
    osascript -e "tell app 'Droplr' to shorten '$1'"
  else
    open -ga /Applications/Droplr.app "$1"
  fi
}
