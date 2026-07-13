#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2329

shellspec_spec_helper_configure() {
  SCRIPTS_DIR="$SHELLSPEC_SPECDIR/.."

  # Build a small sqlite history db (atuin's schema) and point the runner at it
  # via ATUIN_HISTORY_DB, the same override seam the runner resolves at runtime.
  # Timestamps are nanoseconds, matching atuin. "Recent" rows land at now. One
  # "old" row sits ~400 days back to exercise the --recent cutoff. One row is
  # soft-deleted (deleted_at set) to confirm it is filtered out.
  setup_fixture() {
    FIXTURE_DIR=$(mktemp -d)
    export ATUIN_HISTORY_DB="$FIXTURE_DIR/history.db"

    local now old
    now=$(( $(date +%s) * 1000000000 ))
    old=$(( ($(date +%s) - 400 * 86400) * 1000000000 ))

    duckdb << SQL
INSTALL sqlite; LOAD sqlite;
ATTACH '$ATUIN_HISTORY_DB' AS fx (TYPE sqlite);
CREATE TABLE fx.history (
  id VARCHAR, timestamp BIGINT, duration BIGINT, exit BIGINT,
  command VARCHAR, cwd VARCHAR, session VARCHAR, hostname VARCHAR,
  deleted_at BIGINT, author VARCHAR, intent VARCHAR
);
INSERT INTO fx.history (timestamp, command) SELECT $now, 'git push' FROM range(12);
INSERT INTO fx.history (timestamp, command) SELECT $now, 'docker build -t app .' FROM range(3);
INSERT INTO fx.history (timestamp, command) VALUES
  ($now, 'npm test && npm run build'),
  ($now, 'cat foo | grep bar'),
  ($old, 'svn commit -m old');
INSERT INTO fx.history (timestamp, command, deleted_at) VALUES ($now, 'secret token abc', $now);
SQL
  }

  cleanup_fixture() {
    rm -rf "$FIXTURE_DIR"
    unset ATUIN_HISTORY_DB
  }
}

# Any .duckdb files under the fixture dir after a run: proof the runner persisted
# state. In-memory runs leave none.
find_duckdb_artifacts() {
  find "$FIXTURE_DIR" -name '*.duckdb' 2>/dev/null
}
