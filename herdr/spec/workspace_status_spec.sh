#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016

Describe "herdr-workspace-status"
  script="$SHELLSPEC_PROJECT_ROOT/bin/herdr-workspace-status"
  config="$SHELLSPEC_PROJECT_ROOT/config.toml"

  It "is executable"
    When call test -x "$script"
    The status should be success
  End

  It "passes shellcheck"
    no_shellcheck() { ! command -v shellcheck >/dev/null 2>&1; }
    Skip if "shellcheck is not installed" no_shellcheck
    When call shellcheck "$script"
    The status should be success
  End

  It "is reachable on PATH from a login shell"
    on_path() {
      local root resolved
      root=$(cd "$SHELLSPEC_PROJECT_ROOT/.." && pwd)
      resolved=$(zsh -fc 'ZSH=$1; source "$ZSH/herdr/path.zsh"; command -v herdr-workspace-status' _ "$root") || return
      if [[ ! "$resolved" -ef "$script" ]]; then
        echo "resolved $resolved, expected $script"
        return 1
      fi
    }
    When call on_path
    The status should be success
  End

  It "runs on the tab bar interval by the name PATH exports"
    When call grep -q 'command = "herdr-workspace-status"' "$config"
    The status should be success
  End

  It "refuses without herdr on PATH"
    refuse() {
      PATH=/usr/bin:/bin bash "$script" 2>&1
    }
    When call refuse
    The status should be failure
    The output should include "not on PATH"
  End

  # A repo with an origin and a worktree on a topic branch one commit past it,
  # with an edited file. The stub herdr lists that worktree and records what
  # gets reported for it. Neither forge stub is on PATH until a case puts one
  # there, and the origin URL is what picks between them.
  setup_repo() {
    dir=$(mktemp -d)
    stub="$dir/bin"
    mkdir -p "$stub"
    git init -q -b main "$dir/origin"
    git -C "$dir/origin" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base
    git clone -q "$dir/origin" "$dir/repo" 2>/dev/null
    git -C "$dir/repo" switch -q -c topic
    printf 'one\n' > "$dir/repo/file"
    git -C "$dir/repo" add file
    git -C "$dir/repo" -c user.name=t -c user.email=t@t commit -q -m topic
    printf 'two\n' > "$dir/repo/file"
    printf '%s\n' \
      '#!/bin/sh' \
      'case "$1 $2" in' \
      "\"workspace list\") printf '%s' '{\"result\":{\"workspaces\":[{\"workspace_id\":\"w1\",\"label\":\"my-topic\",\"worktree\":{\"checkout_path\":\"$dir/repo\"}}]}}' ;;" \
      "\"workspace report-metadata\") shift 2; printf '%s\\\\n' \"\$@\" > $dir/reported ;;" \
      '*) exit 1 ;;' \
      'esac' > "$stub/herdr"
    chmod +x "$stub/herdr"
  }

  stub_gh() {
    git -C "$dir/repo" remote set-url origin git@github.com:me/repo.git
    printf '%s\n' \
      '#!/bin/sh' \
      'case "$1 $2" in' \
      '"pr list") echo "[{\"number\":7,\"state\":\"OPEN\",\"isDraft\":false,\"mergeable\":\"MERGEABLE\",\"baseRefName\":\"main\",\"headRefOid\":\"0000000\",\"updatedAt\":\"2026-01-01T00:00:00Z\",\"statusCheckRollup\":[{\"status\":\"COMPLETED\",\"conclusion\":\"FAILURE\"}]},{\"number\":3,\"state\":\"CLOSED\",\"isDraft\":false,\"baseRefName\":\"main\",\"updatedAt\":\"2025-01-01T00:00:00Z\",\"statusCheckRollup\":[]}]" ;;' \
      '"api repos/{owner}/{repo}/pulls/7") echo "" ;;' \
      '*) exit 1 ;;' \
      'esac' > "$stub/gh"
    chmod +x "$stub/gh"
  }

  stub_glab() {
    git -C "$dir/repo" remote set-url origin git@gitlab.example.com:me/repo.git
    printf '%s\n' \
      '#!/bin/sh' \
      'case "$1 $2" in' \
      '"mr list") echo "[{\"iid\":9,\"state\":\"opened\",\"draft\":false,\"has_conflicts\":false,\"target_branch\":\"other\",\"sha\":\"0000000\",\"updated_at\":\"2026-01-01T00:00:00Z\"}]" ;;' \
      '"api projects/:id/merge_requests/9") echo "{\"iid\":9,\"head_pipeline\":{\"status\":\"success\"}}" ;;' \
      '*) exit 1 ;;' \
      'esac' > "$stub/glab"
    chmod +x "$stub/glab"
  }

  run_script() {
    PATH="$stub:$PATH" bash "$script" || return 1
    cat "$dir/reported"
  }

  It "reports the branch and a red cluster for a GitHub branch with a failing pull request"
    github() {
      setup_repo
      stub_gh
      run_script
    }
    When call github
    The status should be success
    The output should include "w1"
    The output should include "--source"
    The output should include "branch=topic"
    The output should include "status_red= "
    The output should not include "status_green="
    The output should include "--clear-token"
  End

  It "reports a green stacked cluster for a GitLab branch whose merge request passes"
    gitlab() {
      setup_repo
      stub_glab
      run_script
    }
    When call gitlab
    The status should be success
    The output should include "status_green= "
    The output should not include "status_red="
  End

  It "shows the stack glyph in the worst checks color for a branch with two open pull requests"
    two_open() {
      setup_repo
      stub_gh
      printf '%s\n' \
        '[{"number":7,"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","baseRefName":"main","headRefOid":"0000000","updatedAt":"2026-01-01T00:00:00Z","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]},' \
        ' {"number":10,"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","baseRefName":"other","headRefOid":"0000000","updatedAt":"2026-01-02T00:00:00Z","statusCheckRollup":[{"status":"IN_PROGRESS"}]}]' > "$dir/two.json"
      printf '%s\n' \
        '#!/bin/sh' \
        "[ \"\$1 \$2\" = \"pr list\" ] && exec cat $dir/two.json" \
        '[ "$1" = api ] && exit 0' \
        'exit 1' > "$stub/gh"
      run_script
    }
    When call two_open
    The status should be success
    The output should include "status_yellow= "
    The output should not include ""
  End

  It "shows only the dirty glyph when the branch is both dirty and unpushed"
    dirty_wins() {
      setup_repo
      stub_gh
      rm "$stub/gh"
      run_script
    }
    When call dirty_wins
    The status should be success
    The output should include "status_yellow="
    The output should not include ""
  End

  It "turns the row yellow for unpushed commits on a branch with no pull request"
    unpushed() {
      setup_repo
      stub_gh
      rm "$stub/gh"
      git -C "$dir/repo" checkout -q -- file
      run_script
    }
    When call unpushed
    The status should be success
    The output should include "status_yellow="
    The output should not include ""
  End

  It "does not count a merged pull request's commits as unpushed once its remote branch is gone"
    merged() {
      setup_repo
      stub_gh
      git -C "$dir/repo" checkout -q -- file
      printf '[{"number":8,"state":"MERGED","isDraft":false,"baseRefName":"main","headRefOid":"%s","updatedAt":"2026-01-01T00:00:00Z","statusCheckRollup":[]}]\n' \
        "$(git -C "$dir/repo" rev-parse HEAD)" > "$dir/merged.json"
      printf '%s\n' \
        '#!/bin/sh' \
        "[ \"\$1 \$2\" = \"pr list\" ] && exec cat $dir/merged.json" \
        'exit 1' > "$stub/gh"
      run_script
    }
    When call merged
    The status should be success
    The output should include "status_mauve="
    The output should not include ""
  End

  It "turns a merged pull request yellow once commits land on top of it"
    merged_then_more() {
      setup_repo
      stub_gh
      git -C "$dir/repo" checkout -q -- file
      printf '[{"number":8,"state":"MERGED","isDraft":false,"baseRefName":"main","headRefOid":"%s","updatedAt":"2026-01-01T00:00:00Z","statusCheckRollup":[]}]\n' \
        "$(git -C "$dir/repo" rev-parse HEAD~1)" > "$dir/merged.json"
      printf '%s\n' \
        '#!/bin/sh' \
        "[ \"\$1 \$2\" = \"pr list\" ] && exec cat $dir/merged.json" \
        'exit 1' > "$stub/gh"
      run_script
    }
    When call merged_then_more
    The status should be success
    The output should include "status_yellow= "
    The output should not include "status_mauve="
  End

  It "clears every token for a clean checkout of the default branch"
    clean_default() {
      setup_repo
      stub_gh
      git -C "$dir/repo" checkout -q -- file
      git -C "$dir/repo" switch -q main
      run_script
    }
    When call clean_default
    The status should be success
    The output should not include "--token"
    The output should include "--clear-token"
  End
End
