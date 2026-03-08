#!/usr/bin/env bash
# Extract command frequencies from zsh EXTENDED_HISTORY.
#
# Input format: ": 1661789533:0;git push --force"
#
# Usage:
#   history-freq.sh                    # all-time, top 80
#   history-freq.sh --recent 6m       # last 6 months
#   history-freq.sh --recent 3m -n 40 # last 3 months, top 40
#   history-freq.sh --date-range      # print first/last entry dates

set -euo pipefail
source "$(dirname "$0")/common.sh"

# Avoid multibyte conversion errors from binary data in history
export LC_ALL=C

HISTFILE="${HISTFILE:-$HOME/.zsh_history}"
COUNT=80
RECENT=""
DATE_RANGE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --recent)
      require_arg "$1" $#
      RECENT="$2"
      shift 2
      ;;
    -n)
      require_arg "$1" $#
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
  first=$(awk -F'[:;]' '/^: [0-9]/{print $2; exit}' "$HISTFILE")
  last=$(awk -F'[:;]' '/^: [0-9]/{ts=$2} END{print ts}' "$HISTFILE")
  if [[ -z "$first" || -z "$last" ]]; then
    echo "No history entries found" >&2
    exit 1
  fi
  echo "$(format_epoch "$first") to $(format_epoch "$last")"
  exit 0
fi

if [[ -n "$RECENT" ]]; then
  cutoff=$(duration_to_cutoff "$RECENT")
  extract_commands "$HISTFILE" "$cutoff"
else
  extract_commands "$HISTFILE"
fi | awk '{print $1}' | sort | uniq -c | sort -rn | head -"$COUNT"
