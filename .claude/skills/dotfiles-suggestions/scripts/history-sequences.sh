#!/usr/bin/env bash
# Find repeated multi-command sequences (pipelines and chains) in zsh EXTENDED_HISTORY.
#
# Input format: ": 1661789533:0;git add . && git commit -m 'fix'"
# Matches lines containing && or |
#
# Usage:
#   history-sequences                 # all-time, top 30
#   history-sequences --recent 6m     # last 6 months
#   history-sequences -n 20           # top 20

set -euo pipefail

# Avoid multibyte conversion errors from binary data in history
export LC_ALL=C

HISTFILE="${HISTFILE:-$HOME/.zsh_history}"
COUNT=30
RECENT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --recent)
      RECENT="$2"
      shift 2
      ;;
    -n)
      COUNT="$2"
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

if [[ -n "$RECENT" ]]; then
  cutoff=$(date "$(parse_duration "$RECENT")" +%s)
  awk -F'[:;]' -v cutoff="$cutoff" \
    '/^: [0-9]/ && $2 >= cutoff {sub(/^: [0-9]+:[0-9]+;/, ""); print $0}' \
    "$HISTFILE"
else
  LC_ALL=C sed 's/^: [0-9]*:[0-9]*;//' "$HISTFILE"
fi | grep -E '&&|\|' | sort | uniq -c | sort -rn | head -"$COUNT"
