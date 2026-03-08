#!/usr/bin/env bash
# Show most common argument patterns for top commands in zsh EXTENDED_HISTORY.
#
# Input format: ": 1661789533:0;git push --force"
# Output: for each top command, the most frequent argument combinations
#
# Usage:
#   history-args.sh                      # top 20 commands, 10 patterns each, all-time
#   history-args.sh --recent 6m          # last 6 months
#   history-args.sh -n 10 --patterns 5   # top 10 commands, 5 patterns each

set -euo pipefail
source "$(dirname "$0")/common.sh"

# Avoid multibyte conversion errors from binary data in history
export LC_ALL=C

HISTFILE="${HISTFILE:-$HOME/.zsh_history}"
CMD_COUNT=20
PATTERN_COUNT=10
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
      CMD_COUNT="$2"
      shift 2
      ;;
    --patterns)
      require_arg "$1" $#
      PATTERN_COUNT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

tmpfile=$(mktemp)
trap 'rm -f "$tmpfile"' EXIT

if [[ -n "$RECENT" ]]; then
  cutoff=$(duration_to_cutoff "$RECENT")
  extract_commands "$HISTFILE" "$cutoff" > "$tmpfile"
else
  extract_commands "$HISTFILE" > "$tmpfile"
fi

top_cmds=$(awk '{print $1}' "$tmpfile" | sort | uniq -c | sort -rn | head -"$CMD_COUNT" | awk '{print $2}')

while IFS= read -r cmd; do
  echo "=== $cmd ==="
  awk -v cmd="$cmd" '$1 == cmd {sub(/^[^ ]+ /, ""); print}' "$tmpfile" \
    | sort | uniq -c | sort -rn | head -"$PATTERN_COUNT"
done <<< "$top_cmds"
