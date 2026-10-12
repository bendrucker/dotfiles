# shellcheck shell=dash
# Sourceable Homebrew PATH setup. POSIX sh, so homebrew.sh can source it too.
#
# brew_path [prefix…]
#   Put Homebrew on PATH for the calling shell when it is not there already.
#   The installer leaves brew off PATH until the next login shell, so a fresh
#   machine cannot call it in the same script that installed it. A script that
#   ran homebrew.sh as a child has to call this itself, since a child's PATH
#   never reaches its parent. The prefixes default to Apple Silicon's and
#   Linux's. An Intel Mac's /usr/local/bin is on PATH from the start.

brew_path() {
  command -v brew >/dev/null 2>&1 && return 0
  [ "$#" -gt 0 ] || set -- /opt/homebrew /home/linuxbrew/.linuxbrew

  for prefix in "$@"; do
    if [ -x "$prefix/bin/brew" ]; then
      eval "$("$prefix/bin/brew" shellenv)"
      return 0
    fi
  done
  return 1
}
