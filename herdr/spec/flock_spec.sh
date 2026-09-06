#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016

Describe "herdr-flock"
  launcher="$SHELLSPEC_PROJECT_ROOT/bin/herdr-flock"
  config="$SHELLSPEC_PROJECT_ROOT/config.toml"

  It "is executable"
    When call test -x "$launcher"
    The status should be success
  End

  It "passes shellcheck"
    no_shellcheck() { ! command -v shellcheck >/dev/null 2>&1; }
    Skip if "shellcheck is not installed" no_shellcheck
    When call shellcheck "$launcher"
    The status should be success
  End

  It "is reachable on PATH from a login shell"
    # path.zsh is one of the two files .zshrc skips, so sourcing it under a
    # chosen $ZSH is what the shell does to it. -f keeps the installed root out.
    on_path() {
      local root resolved
      root=$(cd "$SHELLSPEC_PROJECT_ROOT/.." && pwd)
      resolved=$(zsh -fc 'ZSH=$1; source "$ZSH/herdr/path.zsh"; command -v herdr-flock' _ "$root") || return
      if [[ ! "$resolved" -ef "$SHELLSPEC_PROJECT_ROOT/bin/herdr-flock" ]]; then
        echo "resolved $resolved, expected $SHELLSPEC_PROJECT_ROOT/bin/herdr-flock"
        return 1
      fi
    }
    When call on_path
    The status should be success
  End

  binding() {
    sed -n '/key = "prefix+alt+f"/,/^$/p' "$config" |
      sed -n 's/^command = "\(.*\)"$/\1/p'
  }

  It "binds the launcher by a path rather than a name PATH has to resolve"
    # The server holds the environment it started with for as long as it runs,
    # so a bare name resolves against a PATH that can predate herdr/path.zsh.
    # Expanded here the way herdr expands it, with herdr/bin off PATH.
    resolves() {
      local root resolved
      root=$(cd "$SHELLSPEC_PROJECT_ROOT/.." && pwd)
      resolved=$(ZSH="$root" PATH=/usr/bin:/bin sh -c "echo $(binding)")
      if [[ ! "$resolved" -ef "$launcher" ]]; then
        echo "resolved $resolved, expected $launcher"
        return 1
      fi
    }
    When call resolves
    The status should be success
  End

  It "falls back to the installed root when the server carries no \$ZSH"
    # A prefix that can expand to nothing would leave an absolute path rooted at
    # /, which is the same silent miss in a new disguise.
    fallback() {
      env -u ZSH sh -c "echo $(binding)"
    }
    When call fallback
    The output should equal "$HOME/.dotfiles/herdr/bin/herdr-flock"
  End

  It "refuses without herdr on PATH"
    refuse() {
      PATH=/usr/bin:/bin bash "$SHELLSPEC_PROJECT_ROOT/bin/herdr-flock" 2>&1
    }
    When call refuse
    The status should be failure
    The output should include "not on PATH"
  End

  It "yields to a concurrent launch instead of seating a second flock"
    # Two keypresses race the lookup against the create. The loser must not
    # build its own workspace under the same label.
    contend() {
      local dir stub
      dir=$(mktemp -d)
      stub="$dir/bin"
      mkdir -p "$stub" "$dir/herdr-flock.lock"
      echo '{"result":{"snapshot":{"workspaces":[]}}}' > "$dir/snapshot.json"
      printf '%s\n' \
        '#!/bin/sh' \
        "[ \"\$1 \$2\" = \"api snapshot\" ] && exec cat $dir/snapshot.json" \
        'echo "stub herdr: refused $*" >&2' \
        'exit 1' > "$stub/herdr"
      chmod +x "$stub/herdr"
      TMPDIR="$dir" PATH="$stub:$PATH" bash "$launcher" 2>&1
    }
    When call contend
    The status should be failure
    The output should include "another launch holds the lock"
    The output should not include "refused workspace create"
  End

  It "retries agent start once while the pane reaches its prompt"
    retry_start() {
      local dir stub
      dir=$(mktemp -d)
      stub="$dir/bin"
      mkdir -p "$stub"
      echo '{"result":{"snapshot":{"workspaces":[]}}}' > "$dir/snapshot.json"
      echo '{"result":{"root_pane":{"pane_id":"w9:p1"}}}' > "$dir/created.json"
      printf '%s\n' \
        '#!/bin/sh' \
        'case "$1 $2" in' \
        "\"api snapshot\") cat $dir/snapshot.json ;;" \
        "\"workspace create\") cat $dir/created.json ;;" \
        '"agent start")' \
        "  n=\$(cat $dir/tries 2>/dev/null || echo 0)" \
        "  echo \$((n + 1)) > $dir/tries" \
        '  [ "$n" = "0" ] && exit 1' \
        '  ;;' \
        "\"agent prompt\") echo sent > $dir/prompted ;;" \
        '*) exit 1 ;;' \
        'esac' \
        'exit 0' > "$stub/herdr"
      chmod +x "$stub/herdr"
      TMPDIR="$dir" PATH="$stub:$PATH" bash "$launcher" || return 1
      [ "$(cat "$dir/tries")" = "2" ] || { echo "start attempts: $(cat "$dir/tries")"; return 1; }
      [ -s "$dir/prompted" ] || { echo "flock was never prompted"; return 1; }
    }
    When call retry_start
    The status should be success
  End
End
