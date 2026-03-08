#!/usr/bin/env bash
# Extract command frequencies from zsh EXTENDED_HISTORY.
#
# Input format: ": 1661789533:0;git push --force"
#
# Usage:
#   history-freq                    # all-time, top 80
#   history-freq --recent 6m       # last 6 months
#   history-freq --recent 3m -n 40 # last 3 months, top 40
#   history-freq --date-range      # print first/last entry dates

set -euo pipefail

# Avoid multibyte conversion errors from binary data in history
export LC_ALL=C

HISTFILE="${HISTFILE:-$HOME/.zsh_history}"
COUNT=80
RECENT=""
DATE_RANGE=false

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
    --date-range)
      DATE_RANGE=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if $DATE_RANGE; then
  # Show first and last entry timestamps
  first=$(head -1 "$HISTFILE" | awk -F'[:;]' '{print $2}')
  last=$(tail -1 "$HISTFILE" | awk -F'[:;]' '{print $2}')
  echo "$(date -r "$first" +%Y-%m-%d) to $(date -r "$last" +%Y-%m-%d)"
  exit 0
fi

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
  # Filter to entries after cutoff, strip timestamp, extract command name
  awk -F'[:;]' -v cutoff="$cutoff" \
    '/^: [0-9]/ && $2 >= cutoff {sub(/^: [0-9]+:[0-9]+;/, ""); print $0}' \
    "$HISTFILE" | awk '{print $1}' | sort | uniq -c | sort -rn | head -"$COUNT"
else
  # All-time: strip timestamp prefix, extract first word
  sed 's/^: [0-9]*:[0-9]*;//' "$HISTFILE" \
    | awk '{print $1}' | sort | uniq -c | sort -rn | head -"$COUNT"
fi
