#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016

Describe "linear-work"
  script="$SHELLSPEC_PROJECT_ROOT/../bin/linear-work"

  setup() {
    root=$(mktemp -d)
    export XDG_STATE_HOME="$root/state"
    fixtures="$root/fixtures"
    mkdir -p "$fixtures" "$root/stub" "$root/empty" "$root/repo"

    export FIXTURE_DIR="$fixtures"
    export HERDR_CAPTURE="$root/herdr-calls"
    export LINEAR_CAPTURE="$root/linear-calls"
    export FZF_CAPTURE="$root/fzf"
    : >"$HERDR_CAPTURE"
    : >"$LINEAR_CAPTURE"

    git -C "$root/repo" init --quiet
    write_issues
    write_locations '[]' '[]' '[]'
    write_stubs
  }

  cleanup() {
    rm -rf "$root"
  }

  BeforeEach 'setup'
  AfterEach 'cleanup'

  # The script is zsh, so ~/.zshenv runs and brew shellenv in it can put the
  # real linear, herdr, and wt back ahead of the stubs. An empty ZDOTDIR
  # leaves $PATH alone.
  run_script() {
    PATH="$root/stub:$PATH" ZDOTDIR="$root/empty" HERDR_ENV=1 HERDR_PANE_ID=w1:p1 \
      "$script"
  }

  # Each stub records what it was asked for and answers from a fixture, so a
  # test asserts on the herdr topology the script decided to build rather than
  # on anything it drew.
  write_stubs() {
    cat >"$root/stub/linear" <<'SH'
#!/bin/sh
printf 'linear %s\n' "$1 $2 $3" >> "$LINEAR_CAPTURE"
[ "$1" = api ] && cat "$FIXTURE_DIR/issues.json"
exit 0
SH

    cat >"$root/stub/herdr" <<'SH'
#!/bin/sh
printf 'herdr %s\n' "$*" >> "$HERDR_CAPTURE"
case "$1 $2" in
  "workspace list") cat "$FIXTURE_DIR/workspaces.json" ;;
  "tab list")       cat "$FIXTURE_DIR/tabs.json" ;;
  "pane list")      cat "$FIXTURE_DIR/panes.json" ;;
  "pane layout")    echo '{"result":{"layout":{"panes":[{"pane_id":"w1:p2","rect":{"width":250,"height":82}}]}}}' ;;
  "tab create")     echo '{"result":{"root_pane":{"pane_id":"w9:p1"}}}' ;;
  "workspace create") echo '{"result":{"root_pane":{"pane_id":"w9:p1"}}}' ;;
  "pane split")     echo '{"result":{"pane":{"pane_id":"w1:p5"}}}' ;;
  *)                echo '{"result":{"type":"ok"}}' ;;
esac
SH

    # Two fzf calls: the issue picker, which passes --expect and so prints the
    # pressed key first, and the repo picker, which does not.
    cat >"$root/stub/fzf" <<'SH'
#!/bin/sh
input="$FZF_CAPTURE.in.$$"
cat > "$input"
for arg in "$@"; do
  case "$arg" in
    --expect=*)
      cp "$input" "$FZF_CAPTURE.issues"
      printf '%s\n' "${FZF_KEY:-enter}"
      sed -n "${FZF_PICK:-1}p" "$input"
      rm -f "$input"
      exit 0
      ;;
  esac
done
cp "$input" "$FZF_CAPTURE.repos"
sed -n '1p' "$input"
rm -f "$input"
SH

    printf '#!/bin/sh\nprintf "%%s\\n" "$REPO_DIR"\n' >"$root/stub/zoxide"
    printf '#!/bin/sh\nexit 0\n' >"$root/stub/gum"

    chmod +x "$root"/stub/*
    export REPO_DIR="$root/repo"
  }

  # One unstarted issue and one started one, in the order the script's own
  # sort would leave them.
  write_issues() {
    cat >"$fixtures/issues.json" <<'JSON'
{"data":{"viewer":{"assignedIssues":{"nodes":[
  {"identifier":"BEN-15","title":"Started already","branchName":"ben/ben-15-started-already",
   "url":"https://linear.app/ben/issue/BEN-15/started-already","priority":2,
   "updatedAt":"2026-08-10T22:00:00.000Z","state":{"name":"In Progress","type":"started"},
   "team":{"key":"BEN"},"project":{"name":"Tooling"}},
  {"identifier":"BEN-16","title":"Not started yet","branchName":"ben/ben-16-not-started-yet",
   "url":"https://linear.app/ben/issue/BEN-16/not-started-yet","priority":0,
   "updatedAt":"2026-08-10T22:30:00.000Z","state":{"name":"Todo","type":"unstarted"},
   "team":{"key":"BEN"},"project":null}
]}}}}
JSON
  }

  write_locations() {
    printf '{"result":{"workspaces":%s}}\n' "$1" >"$fixtures/workspaces.json"
    printf '{"result":{"tabs":%s}}\n' "$2" >"$fixtures/tabs.json"
    printf '{"result":{"panes":%s}}\n' "$3" >"$fixtures/panes.json"
  }

  no_locations() {
    write_locations \
      '[{"workspace_id":"w1","active_tab_id":"w1:t1","focused":true,"label":"repo"}]' \
      '[{"workspace_id":"w1","tab_id":"w1:t1","label":"1"}]' \
      '[{"workspace_id":"w1","tab_id":"w1:t1","label":"","cwd":"/elsewhere","focused":true,"pane_id":"w1:p1"},
        {"workspace_id":"w1","tab_id":"w1:t1","label":"","cwd":"/elsewhere","focused":false,"pane_id":"w1:p2"}]'
  }

  herdr_calls() { cat "$HERDR_CAPTURE"; }
  linear_calls() { cat "$LINEAR_CAPTURE"; }

  Describe "the picker"
    It "sorts started issues above unstarted ones"
      rows() { no_locations; run_script >/dev/null 2>&1; cat "$FZF_CAPTURE.issues"; }
      When call rows
      The status should be success
      The line 1 should include "BEN-15"
      The line 2 should include "BEN-16"
    End

    It "shows the state and project alongside the title"
      rows() { no_locations; run_script >/dev/null 2>&1; head -1 "$FZF_CAPTURE.issues"; }
      When call rows
      The output should include "In Progress"
      The output should include "Started already"
      The output should include "· Tooling"
    End

    # fzf hands the preview {1}, so nothing may precede the identifier.
    It "leads every row with the identifier"
      first_fields() {
        no_locations; run_script >/dev/null 2>&1
        awk '{ print $1 }' "$FZF_CAPTURE.issues"
      }
      When call first_fields
      The line 1 should equal "BEN-15"
      The line 2 should equal "BEN-16"
    End

    It "marks a row herdr already has open"
      marked() {
        write_locations '[]' '[]' \
          '[{"workspace_id":"w3","tab_id":"w3:t1","label":"BEN-15","cwd":"/elsewhere","pane_id":"w3:p1"}]'
        run_script >/dev/null 2>&1
        cat "$FZF_CAPTURE.issues"
      }
      When call marked
      The line 1 should include "●"
      The line 2 should not include "●"
    End
  End

  Describe "reuse"
    # wt's sanitize filter only flattens slashes, so this is the directory the
    # branch's worktree lands in.
    It "focuses a pane whose foreground directory is the issue's worktree"
      focus() {
        write_locations '[]' '[]' \
          '[{"workspace_id":"w4","tab_id":"w4:t2","label":"",
             "cwd":"/repo","foreground_cwd":"/wt/ben-ben-15-started-already","pane_id":"w4:p1"}]'
        run_script >/dev/null 2>&1
        herdr_calls
      }
      When call focus
      The output should include "workspace focus w4"
      The output should include "tab focus w4:t2"
      The output should not include "tab create"
    End

    It "focuses a location labelled with the identifier"
      focus() {
        write_locations '[]' '[{"workspace_id":"w5","tab_id":"w5:t1","label":"BEN-15"}]' '[]'
        run_script >/dev/null 2>&1
        herdr_calls
      }
      When call focus
      The output should include "tab focus w5:t1"
      The output should not include "tab create"
    End

    # The alternates choose a topology for new work. They never duplicate a
    # location that already exists.
    It "focuses rather than splitting when an alternate key is pressed"
      focus() {
        write_locations '[]' '[{"workspace_id":"w5","tab_id":"w5:t1","label":"BEN-15"}]' '[]'
        FZF_KEY=alt-p run_script >/dev/null 2>&1
        herdr_calls
      }
      When call focus
      The output should include "tab focus w5:t1"
      The output should not include "pane split"
    End
  End

  Describe "building a location"
    It "opens a tab on enter and hands the pane wt plus claude"
      built() { no_locations; run_script >/dev/null 2>&1; herdr_calls; }
      When call built
      The output should include "tab create --cwd $root/repo --label BEN-15 --focus"
      The output should include "pane run w9:p1 wt switch --create ben/ben-15-started-already -x claude"
      The output should include "pane rename w9:p1 BEN-15"
    End

    It "passes the issue URL to the issue skill"
      built() { no_locations; run_script >/dev/null 2>&1; herdr_calls; }
      When call built
      The output should include "/issue\\ https://linear.app/ben/issue/BEN-15/started-already"
    End

    It "drops the agent for a shift variant"
      built() { no_locations; FZF_KEY=alt-T run_script >/dev/null 2>&1; herdr_calls; }
      When call built
      The output should include "pane run w9:p1 wt switch --create ben/ben-15-started-already"
      The output should not include "claude"
    End

    It "splits a pane on alt-p"
      built() { no_locations; FZF_KEY=alt-p run_script >/dev/null 2>&1; herdr_calls; }
      When call built
      The output should include "pane split --pane w1:p2 --direction right --cwd $root/repo"
      The output should include "pane run w1:p5 wt switch"
    End

    It "creates a workspace on alt-w"
      built() { no_locations; FZF_KEY=alt-w run_script >/dev/null 2>&1; herdr_calls; }
      When call built
      The output should include "workspace create --cwd $root/repo --label BEN-15 --focus"
    End

    # wt refuses --create for a branch it can already see.
    It "omits --create when the branch exists"
      built() {
        no_locations
        git -C "$root/repo" commit --quiet --allow-empty -m init
        git -C "$root/repo" branch ben/ben-15-started-already
        run_script >/dev/null 2>&1
        herdr_calls
      }
      When call built
      The output should include "wt switch ben/ben-15-started-already"
      The output should not include "--create"
    End
  End

  Describe "the team to repo memory"
    state_file() { cat "$XDG_STATE_HOME/dotfiles/linear-repos"; }

    It "records the repo chosen for the issue's team"
      choose() { no_locations; run_script >/dev/null 2>&1; state_file; }
      When call choose
      The output should equal "$(printf 'BEN\t%s' "$root/repo")"
    End

    It "offers the remembered repo before anything zoxide knows"
      seeded() {
        no_locations
        mkdir -p "$XDG_STATE_HOME/dotfiles" "$root/remembered"
        git -C "$root/remembered" init --quiet
        printf 'BEN\t%s\n' "$root/remembered" >"$XDG_STATE_HOME/dotfiles/linear-repos"
        run_script >/dev/null 2>&1
        head -1 "$FZF_CAPTURE.repos"
      }
      When call seeded
      The output should equal "$root/remembered"
    End

    It "replaces the team's entry rather than appending to it"
      rewritten() {
        no_locations
        mkdir -p "$XDG_STATE_HOME/dotfiles"
        printf 'DIS\t/other\nBEN\t/stale\n' >"$XDG_STATE_HOME/dotfiles/linear-repos"
        run_script >/dev/null 2>&1
        state_file
      }
      When call rewritten
      The output should include "DIS"
      The output should not include "/stale"
      The lines of output should equal 2
    End
  End

  Describe "the state transition"
    It "starts an unstarted issue"
      started() { no_locations; FZF_PICK=2 run_script >/dev/null 2>&1; sleep 1; linear_calls; }
      When call started
      The output should include "issue update BEN-16"
    End

    It "leaves an already started issue alone"
      started() { no_locations; run_script >/dev/null 2>&1; sleep 1; linear_calls; }
      When call started
      The output should not include "issue update"
    End
  End

  It "refuses to run outside a herdr session"
    outside() {
      PATH="$root/stub:$PATH" ZDOTDIR="$root/empty" HERDR_ENV='' "$script"
    }
    When call outside
    The status should be failure
    The stdout should equal ""
  End
End
