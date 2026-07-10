#!/usr/bin/env bash
# Run a named DuckDB query from resources/queries/ against atuin's SQLite history.
#
# atuin stores command history in a SQLite db that DuckDB attaches read-only.
# The query files are pure, parameterized SQL (getvariable('cutoff'/'limit'));
# this wrapper supplies the one thing a .sql file can't: the shell-resolved,
# absolute db path for ATTACH (DuckDB does not expand ~).
#
# Usage:
#   atuin-query.sh <query-name> [--recent <6m|30d|1y>] [-n <limit>]
#
#   atuin-query.sh command-frequency
#   atuin-query.sh command-frequency --recent 6m
#   atuin-query.sh alias-candidates --recent 6m
#   atuin-query.sh arg-patterns --recent 6m -n 15

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUERY_DIR="$SCRIPT_DIR/../resources/queries"

DB="${ATUIN_HISTORY_DB:-${XDG_DATA_HOME:-$HOME/.local/share}/atuin/history.db}"

# Convert a human-friendly duration (6m, 30d, 1y) to an epoch cutoff timestamp.
# Approximate month/year lengths. Precise enough for history analysis.
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

# Sensible default row cap per query (arg-patterns caps top commands, not rows).
default_limit() {
  case "$1" in
    command-frequency) echo 80 ;;
    alias-candidates)  echo 25 ;;
    arg-patterns)      echo 20 ;;
    sequences)         echo 30 ;;
    *)                 echo 80 ;;
  esac
}

QUERY=""
RECENT=""
LIMIT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --recent)
      [[ $# -ge 2 ]] || { echo "--recent requires an argument" >&2; exit 1; }
      RECENT="$2"
      shift 2
      ;;
    -n)
      [[ $# -ge 2 ]] || { echo "-n requires an argument" >&2; exit 1; }
      LIMIT="$2"
      shift 2
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      if [[ -z "$QUERY" ]]; then
        QUERY="$1"
        shift
      else
        echo "Unexpected argument: $1" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$QUERY" ]]; then
  echo "Usage: atuin-query.sh <query-name> [--recent <dur>] [-n <limit>]" >&2
  exit 1
fi

QUERY_FILE="$QUERY_DIR/$QUERY.sql"
if [[ ! -f "$QUERY_FILE" ]]; then
  echo "Unknown query: '$QUERY'. Available:" >&2
  for f in "$QUERY_DIR"/*.sql; do
    echo "  $(basename "$f" .sql)" >&2
  done
  exit 1
fi

if [[ ! -f "$DB" ]]; then
  echo "atuin history db not found: $DB" >&2
  echo "Set ATUIN_HISTORY_DB or ensure atuin is installed and has recorded history." >&2
  exit 1
fi

if [[ -n "$RECENT" ]]; then
  CUTOFF="$(duration_to_cutoff "$RECENT")"
else
  CUTOFF="NULL"
fi

[[ -n "$LIMIT" ]] || LIMIT="$(default_limit "$QUERY")"

duckdb <<SQL
INSTALL sqlite; LOAD sqlite;
ATTACH '$DB' AS atuin (TYPE sqlite, READ_ONLY);
SET VARIABLE cutoff = $CUTOFF;
SET VARIABLE "limit" = $LIMIT;
.read $QUERY_FILE
SQL
