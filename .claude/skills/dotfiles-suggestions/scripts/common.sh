#!/usr/bin/env bash
# Shared helpers for history analysis scripts.

# Convert a human-friendly duration (6m, 30d, 1y) to an epoch cutoff timestamp.
# Uses approximate month/year lengths — precise enough for history analysis.
duration_to_cutoff() {
  local input="$1"
  if [[ ! "$input" =~ ^[0-9]+[mMdDyY]?$ ]]; then
    echo "Invalid duration format: '$input' (expected e.g., 6m, 30d, 1y)" >&2
    return 1
  fi

  local val="${input%[mMdDyY]}"
  local unit="${input: -1}"
  local seconds

  case "$unit" in
    d|D) seconds=$((val * 86400)) ;;
    y|Y) seconds=$((val * 365 * 86400)) ;;
    *)   seconds=$((val * 30 * 86400)) ;;
  esac

  echo $(( $(date +%s) - seconds ))
}

# Format an epoch timestamp as YYYY-MM-DD.
format_epoch() {
  perl -e 'use POSIX qw(strftime); print strftime("%Y-%m-%d", localtime($ARGV[0])), "\n"' "$1"
}

# Extract full command lines from a zsh EXTENDED_HISTORY file.
# Filters to lines starting with ": <timestamp>:" and strips the prefix.
# Skips multi-line continuation lines that lack the timestamp prefix.
#
# Args:
#   $1 - path to history file
#   $2 - (optional) epoch cutoff; only entries after this timestamp are included
extract_commands() {
  local histfile="$1"
  local cutoff="${2:-}"

  if [[ ! -f "$histfile" ]]; then
    echo "History file not found: $histfile" >&2
    return 1
  fi

  if [[ -n "$cutoff" ]]; then
    awk -F'[:;]' -v cutoff="$cutoff" \
      '/^: [0-9]/ && $2 >= cutoff {sub(/^: [0-9]+:[0-9]+;/, ""); print $0}' \
      "$histfile"
  else
    awk '/^: [0-9]/ {sub(/^: [0-9]+:[0-9]+;/, ""); print $0}' "$histfile"
  fi
}

# Validate that a required argument follows a flag.
require_arg() {
  local flag="$1"
  local remaining="$2"
  if [[ "$remaining" -lt 2 ]]; then
    echo "$flag requires an argument" >&2
    exit 1
  fi
}
