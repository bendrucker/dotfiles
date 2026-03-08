#!/usr/bin/env bash
# Show most common argument patterns for top commands in zsh EXTENDED_HISTORY.
#
# Input format: ": 1661789533:0;git push --force"
# Output: for each top command, the most frequent argument combinations
#
# Usage:
#   history-args                      # top 20 commands, 10 patterns each, all-time
#   history-args --recent 6m          # last 6 months
#   history-args -n 10 --patterns 5   # top 10 commands, 5 patterns each

set -euo pipefail

# Avoid multibyte conversion errors from binary data in history
export LC_ALL=C

HISTFILE="${HISTFILE:-$HOME/.zsh_history}"
CMD_COUNT=20
PATTERN_COUNT=10
RECENT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --recent)
      RECENT="$2"
      shift 2
      ;;
    -n)
      CMD_COUNT="$2"
      shift 2
      ;;
    --patterns)
      PATTERN_COUNT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

parse_duration() {
  local val="${1%[mMdDyY]}"
  local unit="${1: -1}"
  case "$unit" in
    m|M) echo "-v-${val}m" ;;
    d|D) echo "-v-${val}d" ;;
    y|Y) echo "-v-${val}y" ;;
    *)   echo "-v-${1}m" ;;
  esac
}

extract_commands() {
  if [[ -n "$RECENT" ]]; then
    local cutoff
    cutoff=$(date "$(parse_duration "$RECENT")" +%s)
    LC_ALL=C awk -F'[:;]' -v cutoff="$cutoff" \
      '/^: [0-9]/ && $2 >= cutoff {sub(/^: [0-9]+:[0-9]+;/, ""); print $0}' \
      "$HISTFILE"
  else
    LC_ALL=C sed 's/^: [0-9]*:[0-9]*;//' "$HISTFILE"
  fi
}

top_cmds=$(extract_commands | awk '{print $1}' | sort | uniq -c | sort -rn | head -"$CMD_COUNT" | awk '{print $2}')

for cmd in $top_cmds; do
  echo "=== $cmd ==="
  # Strip command name to isolate arguments, e.g. "git push --force" → "push --force"
  extract_commands | grep "^$cmd " | sed "s/^$cmd //" | sort | uniq -c | sort -rn | head -"$PATTERN_COUNT"
done
