#!/usr/bin/env bash
# Shared helpers for history analysis scripts.

# Convert a human-friendly duration (6m, 30d, 1y) to an epoch cutoff timestamp.
# Supports both BSD (macOS) and GNU (Linux) date.
duration_to_cutoff() {
  local input="$1"
  if [[ ! "$input" =~ ^[0-9]+[mMdDyY]?$ ]]; then
    echo "Invalid duration format: '$input' (expected e.g., 6m, 30d, 1y)" >&2
    return 1
  fi

  local val="${input%[mMdDyY]}"
  local unit="${input: -1}"

  # Bare number defaults to months
  if [[ "$unit" =~ ^[0-9]$ ]]; then
    unit="m"
  fi

  if date -v-1d +%s >/dev/null 2>&1; then
    # BSD date (macOS)
    case "$unit" in
      m|M) date -v-"${val}m" +%s ;;
      d|D) date -v-"${val}d" +%s ;;
      y|Y) date -v-"${val}y" +%s ;;
    esac
  else
    # GNU date (Linux)
    case "$unit" in
      m|M) date -d "$val months ago" +%s ;;
      d|D) date -d "$val days ago" +%s ;;
      y|Y) date -d "$val years ago" +%s ;;
    esac
  fi
}

# Format an epoch timestamp as YYYY-MM-DD.
# Supports both BSD (macOS) and GNU (Linux) date.
format_epoch() {
  local epoch="$1"
  if date -v-1d +%s >/dev/null 2>&1; then
    date -r "$epoch" +%Y-%m-%d
  else
    date -d "@$epoch" +%Y-%m-%d
  fi
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
