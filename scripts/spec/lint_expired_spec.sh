#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "lint-expired"
  setup() {
    lint="$SHELLSPEC_PROJECT_ROOT/lint-expired"
    sandbox="$SHELLSPEC_TMPBASE/lint-expired"
    rm -rf "$sandbox"
    mkdir -p "$sandbox"
    git -C "$sandbox" init --quiet
    export LINT_EXPIRED_TODAY=2026-07-28
  }
  BeforeEach 'setup'

  # git grep only sees tracked files, so a fixture has to be staged.
  fixture() {
    printf '%s\n' "$@" > "$sandbox/migration.sh"
    git -C "$sandbox" add -A
  }

  run_lint() {
    "$lint" "$sandbox"
  }

  It "passes when the date is still in the future"
    fixture '# EXPIRES: 2099-12-31 the slow machine has not synced yet'

    When call run_lint
    The status should be success
    The output should equal ""
    The stderr should equal ""
  End

  It "passes when nothing is marked at all"
    fixture 'echo no markers here'

    When call run_lint
    The status should be success
  End

  It "reports the location, date, and reason once past the date"
    fixture '# EXPIRES: 2026-07-27 every machine has the upgrade job'

    When call run_lint
    The status should be failure
    The stderr should include "1 migration is past the expiry date"
    The stderr should include "migration.sh:1"
    The stderr should include "EXPIRES: 2026-07-27"
    The stderr should include "every machine has the upgrade job"
  End

  It "treats the expiry date itself as not yet due"
    fixture '# EXPIRES: 2026-07-28 expires today'

    When call run_lint
    The status should be success
  End

  It "counts more than one expired marker"
    fixture '# EXPIRES: 2020-01-01 first' 'echo x' '# EXPIRES: 2021-01-01 second'

    When call run_lint
    The status should be failure
    The stderr should include "2 migrations are past the expiry date"
  End

  It "keeps a reason containing a percent sign or colon intact"
    fixture '# EXPIRES: 2020-01-01 100% of machines: done'

    When call run_lint
    The status should be failure
    The stderr should include "100% of machines: done"
  End

  # A date that can never fire is worse than no marker, because it reads as
  # tracked when it isn't.
  It "rejects a marker with no parseable date"
    fixture '# EXPIRES: soon enough'

    When call run_lint
    The status should be failure
    The stderr should include "malformed"
    The stderr should include "migration.sh:1"
  End

  It "rejects an out-of-range month and day"
    fixture '# EXPIRES: 2026-13-45 typo'

    When call run_lint
    The status should be failure
    The stderr should include "malformed"
  End

  It "ignores a marker in an untracked file"
    fixture 'echo tracked'
    printf '# EXPIRES: 2020-01-01 untracked\n' > "$sandbox/untracked.sh"

    When call run_lint
    The status should be success
  End
End
