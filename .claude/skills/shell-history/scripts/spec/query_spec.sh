#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "query.sh"
  Before 'setup_fixture'
  After 'cleanup_fixture'

  QUERY="$SHELLSPEC_SPECDIR/../query.sh"

  It "reports the top command by frequency"
    When run command env "$QUERY" command-frequency
    The status should be success
    The output should include "git"
  End

  It "surfaces frequent two-word prefixes as alias candidates"
    When run command env "$QUERY" alias-candidates --recent 6m
    The output should include "git push"
  End

  It "finds && chains in sequences"
    When run command env "$QUERY" sequences --recent 6m
    The output should include "&&"
  End

  It "finds | pipes in sequences"
    When run command env "$QUERY" sequences --recent 6m
    The output should include "|"
  End

  It "excludes entries older than the --recent window"
    When run command env "$QUERY" command-frequency --recent 6m
    The output should not include "svn"
  End

  It "includes old entries in all-time frequency"
    When run command env "$QUERY" command-frequency
    The output should include "svn"
  End

  It "excludes soft-deleted rows"
    When run command env "$QUERY" command-frequency
    The output should not include "secret"
  End

  It "writes no .duckdb file (in-memory only)"
    When run command env "$QUERY" command-frequency
    The status should be success
    The path "$ATUIN_HISTORY_DB.duckdb" should not be exist
    The result of function find_duckdb_artifacts should equal ""
  End

  It "exits non-zero with a clear message when the db is missing"
    When run command env ATUIN_HISTORY_DB=/nonexistent/history.db "$QUERY" date-range
    The status should be failure
    The stderr should include "not found"
  End

  It "rejects an invalid --recent duration"
    When run command env "$QUERY" command-frequency --recent 6x
    The status should be failure
    The stderr should include "Invalid duration"
  End

  It "reports available queries for an unknown query name"
    When run command env "$QUERY" bogus
    The status should be failure
    The stderr should include "Unknown query"
  End
End
