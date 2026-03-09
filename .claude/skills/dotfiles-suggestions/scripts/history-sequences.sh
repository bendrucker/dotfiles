#!/usr/bin/env bash
# Find repeated multi-command sequences (pipelines and chains) in zsh EXTENDED_HISTORY.
#
# Input format: ": 1661789533:0;git add . && git commit -m 'fix'"
# Matches lines containing && or |
#
# Usage:
#   history-sequences.sh                 # all-time, top 30
#   history-sequences.sh --recent 6m     # last 6 months
#   history-sequences.sh -n 20           # top 20

set -euo pipefail
source "$(dirname "$0")/common.sh"

# Avoid multibyte conversion errors from binary data in history
export LC_ALL=C

HISTFILE="${HISTFILE:-$HOME/.zsh_history}"
COUNT=30
RECENT=""

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
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$RECENT" ]]; then
  cutoff=$(duration_to_cutoff "$RECENT")
  extract_commands "$HISTFILE" "$cutoff"
else
  extract_commands "$HISTFILE"
fi | { grep -E '&&|\|' || true; } | sort | uniq -c | sort -rn | head -"$COUNT"
