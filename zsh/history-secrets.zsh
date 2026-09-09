#!/usr/bin/env zsh

# Keep pasted credentials out of $HISTFILE.
#
# atuin filters its own store through history_filter and secrets_filter (see
# atuin/config.toml), but it records from preexec, so a zshaddhistory hook
# returning non-zero does nothing to it. The two filters are independent, and
# this one has to stand alone: none of atuin's built-in patterns reach the
# plaintext file zsh writes.
#
# HISTORY_IGNORE cannot take this over as config. The (#i) flag it needs to
# match TOKEN and token alike is only live under EXTENDED_GLOB, which changes
# how ^, ~ and # parse in every glob the shell expands.
#
# Patterns are POSIX extended regexps matched against the lowercased line, so
# they are written in lowercase and need no case flags. Nothing here forks, and
# one pass over the whole list costs under a millisecond on a 450-character
# line, so no cheap glob screens for it: a second list to keep in step with
# this one could silently disable a pattern in exchange for nothing.

typeset -ga _history_secret_patterns
_history_secret_patterns=(
  # A credential-shaped name assigned a value: GITHUB_TOKEN=..., --password=...,
  # api_key=.... Requiring the value is what keeps `kubectl get secrets` and
  # `--title "token bucket"` in the history.
  '(api[_-]?key|apikey|auth[_-]?token|secret|token|pass(word|wd|phrase)?|credential|private[_-]?key|access[_-]?key)[a-z0-9_]*[[:space:]]*=[[:space:]]*[^[:space:]=]'
  '--(api[_-]?key|secret|token|pass(word|wd|phrase)?|auth|credential)[[:space:]]+[^[:space:]-]'
  'authorization:[[:space:]]*(bearer|token|basic)?[[:space:]]*[^[:space:]]{8,}'
  'bearer[[:space:]]+[a-z0-9._~+/=-]{16,}'
  # user:password, as a curl -u pair or as the userinfo of a url. The length
  # floor is what leaves `docker run -u 1000:1000` alone.
  '(^|[[:space:]])-u[[:space:]]?[a-z0-9._%+-]+:[^[:space:]]{8,}'
  '://[^[:space:]/@]+:[^[:space:]/@]{6,}@'
  # mysql takes its password attached to the flag, which no --flag value or
  # name=value rule sees. Naming the clients keeps `-p 8080:80` out of it.
  '(^|[[:space:]])(mysql|mysqldump|mysqladmin|mariadb)[a-z]*([[:space:]][^;|&]*)?[[:space:]]-p[^[:space:]-]'
  # Cloud credential variable names, which carry the value as a bare argument
  # often enough that the assignment rule above misses them.
  '(aws|azure|gcp|google)[a-z0-9_]*_(secret|token|key)'
  'a[ks]ia[0-9a-z]{16}'
  'gh[pousr]_[a-z0-9._-]{20,}'
  '(gh1_|github_pat_)[a-z0-9_]{20,}'
  'glpat-[a-z0-9_-]{20,}'
  'xox[abeprs][.-][a-z0-9.-]{10,}'
  'xapp-[a-z0-9-]{10,}'
  'hooks\.slack\.com/services/'
  # sk- wants 32 characters because no provider issues one shorter and branch
  # names beginning sk- are cheap.
  'sk-[a-z0-9_-]{32,}'
  'sk_(test|live)_[a-z0-9]{24,}'
  'nf[pcoub]_[a-z0-9]{36}'
  'npm_[a-z0-9]{36}'
  'pplx-[a-z0-9]{20,}'
  'pul-[0-9a-f]{40}'
  'rubygems_[0-9a-f]{20,}'
  'v1\.[0-9a-f]{40}'
)

# Returning non-zero keeps the line out of $HISTFILE. zsh holds it in the
# running shell's history until the next command either way, which is what
# still lets the line be recalled and edited right after it runs.
_history_secret_filter() {
  local line=${${1%$'\n'}:l}
  [[ -z $line || $line == ' '* ]] && return 1

  local pattern
  for pattern in $_history_secret_patterns; do
    [[ $line =~ $pattern ]] && return 1
  done
  return 0
}

# add-zsh-hook is not autoloaded until after .zshrc has sourced every topic
# file, and appending here is what it would do anyway. The unique attribute
# makes a re-source (dotfiles dev enable) idempotent.
typeset -gaU zshaddhistory_functions
zshaddhistory_functions+=(_history_secret_filter)
