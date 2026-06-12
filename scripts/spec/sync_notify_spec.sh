#!/usr/bin/env bash
# notified is consumed by a shellspec matcher the linter cannot see, and the
# stub functions read as unused.
# shellcheck disable=SC2034,SC2329

Describe "git_sync_notify"
  setup() {
    # shellcheck source=/dev/null
    source "$SHELLSPEC_PROJECT_ROOT/lib/git-sync.sh"
    # shellcheck source=/dev/null
    source "$SHELLSPEC_PROJECT_ROOT/lib/sync-notify.sh"
    notified=""
  }
  BeforeEach 'setup'

  # Stubs override the real git_sync/notify sourced above; defined per example
  # so they take effect after setup.

  It "echoes the rev, returns updated, and does not notify"
    git_sync() { echo "abc1234"; return "$GIT_SYNC_UPDATED"; }
    notify() { notified="$1: $2"; }
    When call git_sync_notify /repo "Title"
    The status should equal "$GIT_SYNC_UPDATED"
    The output should equal "abc1234"
    The variable notified should equal ""
  End

  It "returns current with no rev and does not notify"
    git_sync() { return "$GIT_SYNC_CURRENT"; }
    notify() { notified="$1: $2"; }
    When call git_sync_notify /repo "Title"
    The status should equal "$GIT_SYNC_CURRENT"
    The output should equal ""
    The variable notified should equal ""
  End

  It "returns failed and notifies"
    git_sync() { return "$GIT_SYNC_FAILED"; }
    notify() { notified="$1: $2"; }
    When call git_sync_notify /repo "Title"
    The status should equal "$GIT_SYNC_FAILED"
    The variable notified should equal "Title: Failed: could not sync"
  End
End
