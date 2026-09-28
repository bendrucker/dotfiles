#!/usr/bin/env zsh
# Caches the shell code a tool prints for `eval "$(tool ...)"`, so startup
# reads a file instead of forking the tool on every shell.
#
#   _eval_cache [--expect <prefix>] [--depends <file>]... <tool> [args...] && eval "$REPLY"
#
# Sets REPLY to the code rather than evaluating it, so it runs in the caller's
# scope the way the plain eval did. The file lives under $XDG_CACHE_HOME and
# is never tracked.
#
# A hit only reads the file with builtins. The first line records the tool's
# resolved path and the arguments. An upgrade through Homebrew or mise moves the
# resolved path, and a tool that replaces itself in place leaves a binary newer
# than the cache. Either one regenerates, and so does a --depends file newer
# than the cache, for a tool whose output comes from files beside the binary.
#
# Output that is empty, came from a failing run, or lacks the --expect prefix
# is not cached, and the call returns 1. A cache that cannot be written still
# hands back fresh output, since .zshenv reaches this from shells that may not
# own $XDG_CACHE_HOME.
#
# Sourced from .zshenv so path setup can use it, and again by the .zshrc topic
# loop, which only redefines the function.

_eval_cache() {
  local expect= dep
  local -a deps
  while [[ $1 == --* ]]; do
    case $1 in
      --expect) expect=$2 ;;
      --depends) deps+=($2) ;;
      *) return 1 ;;
    esac
    shift 2
  done
  local bin
  if [[ $1 == */* ]]; then
    bin=${1:A}
  else
    bin=${commands[$1]:A}
  fi
  [[ -x $bin ]] || return 1

  local dir=${XDG_CACHE_HOME:-$HOME/.cache}/zsh/eval
  local file=$dir/${${(j:_:)${@:t}}//[^A-Za-z0-9_-]/_}.zsh
  local key="# $bin ${(q)@[2,-1]}" line= fresh=1

  for dep in $bin $deps; do
    [[ $file -nt $dep ]] || fresh=
  done
  if [[ -n $fresh && -r $file ]] && read -r line < $file && [[ $line == "$key" ]]; then
    REPLY=$(<$file)
    return 0
  fi

  REPLY=$(command "$@") || return 1
  [[ -n $REPLY && $REPLY == "$expect"* ]] || return 1
  {
    [[ -d $dir ]] || mkdir -p -- $dir
    print -r -- "$key"$'\n'"$REPLY" >| $file.$$ && command mv -f -- $file.$$ $file
  } 2>/dev/null
  return 0
}
