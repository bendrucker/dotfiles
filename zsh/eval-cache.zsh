#!/usr/bin/env zsh
# Caches the shell code a tool prints for `eval "$(tool ...)"`, so startup
# sources a file instead of forking the tool on every shell.
#
#   _eval_cache [--expect <prefix>] <tool> [args...] && source "$REPLY"
#
# Sets REPLY to the cache file rather than sourcing it, so the generated code
# runs in the caller's scope the way eval did. The file lives under
# $XDG_CACHE_HOME and is never tracked.
#
# A hit only reads the file with builtins. The first line records the tool's
# resolved path and the arguments. An upgrade through Homebrew or mise moves the
# resolved path, and a tool that replaces itself in place leaves a binary newer
# than the cache. Either one regenerates. Output that is empty, came from a
# failing run, or lacks the --expect prefix is not cached, and the call
# returns 1.

_eval_cache() {
  local expect=
  if [[ $1 == --expect ]]; then
    expect=$2
    shift 2
  fi
  local bin=${commands[$1]:A}
  [[ -n $bin ]] || return 1

  local dir=${XDG_CACHE_HOME:-$HOME/.cache}/zsh/eval
  REPLY=$dir/${${(j:_:)@}//[^A-Za-z0-9_-]/_}.zsh
  local key="# $bin ${(q)@[2,-1]}" line=

  if [[ -r $REPLY && $REPLY -nt $bin ]] && read -r line < $REPLY && [[ $line == "$key" ]]; then
    return 0
  fi

  local out
  out=$(command "$@") || return 1
  [[ -n $out && $out == "$expect"* ]] || return 1
  [[ -d $dir ]] || mkdir -p -- $dir || return 1
  print -r -- "$key"$'\n'"$out" >| $REPLY.$$ && command mv -f -- $REPLY.$$ $REPLY
}
