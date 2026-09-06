#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016

Describe "herdr-grab-scrollback"
  launcher="$SHELLSPEC_PROJECT_ROOT/bin/herdr-grab-scrollback"
  config="$SHELLSPEC_PROJECT_ROOT/config.toml"

  It "is executable"
    When call test -x "$launcher"
    The status should be success
  End

  It "passes shellcheck"
    Skip if "shellcheck is not installed" shellcheck_missing
    When call shellcheck "$launcher"
    The status should be success
  End

  It "is reachable on PATH from a login shell"
    When call launcher_on_path herdr-grab-scrollback
    The status should be success
  End

  It "binds the launcher by the name PATH exports"
    When call grep -q 'command = "herdr-grab-scrollback"' "$config"
    The status should be success
  End

  It "refuses without herdr on PATH"
    refuse() {
      PATH=/usr/bin:/bin bash "$launcher" 2>&1
    }
    When call refuse
    The status should be failure
    The output should include "not on PATH"
  End

  # A stub herdr whose `pane read` echoes the arguments it was handed, so a
  # test can assert which pane and which capture window the script asked for.
  stub_herdr() {
    local dir="$1" pane_json="$2"
    mkdir -p "$dir/bin"
    printf '%s\n' \
      '#!/bin/sh' \
      'case "$1 $2" in' \
      "\"pane current\") echo '$pane_json' ;;" \
      '"pane read") echo "$3 $5 $6 $7" ;;' \
      "\"notification show\") echo \"\$3\" >> $dir/toasts ;;" \
      '*) exit 1 ;;' \
      'esac' > "$dir/bin/herdr"
    printf '%s\n' '#!/bin/sh' "cat > $dir/clipboard" > "$dir/bin/pbcopy"
    chmod +x "$dir/bin/herdr" "$dir/bin/pbcopy"
  }

  It "asks for the whole history rather than the visible screen"
    # The default capture window is one screen, which drops exactly the log
    # that already scrolled past. Losing the flag would still copy something,
    # so only asserting on it catches the regression.
    grab() {
      local dir
      dir=$(mktemp -d)
      stub_herdr "$dir" '{"result":{"pane":{"pane_id":"w9:p2"}}}'
      PATH="$dir/bin:$PATH" bash "$launcher" || return 1
      cat "$dir/clipboard"
    }
    When call grab
    The status should be success
    The output should equal "w9:p2 recent-unwrapped --lines 10000"
  End

  It "leaves the clipboard alone when the pane cannot be read"
    # Piping a failed read straight through would replace whatever the user
    # was holding with nothing, which is worse than doing nothing at all.
    keep_clipboard() {
      local dir
      dir=$(mktemp -d)
      stub_herdr "$dir" '{"result":{"pane":{"pane_id":"w9:p2"}}}'
      printf '%s\n' '#!/bin/sh' 'case "$1 $2" in' \
        "\"pane current\") echo '{\"result\":{\"pane\":{\"pane_id\":\"w9:p2\"}}}' ;;" \
        '"pane read") exit 1 ;;' \
        "\"notification show\") : ;;" \
        'esac' > "$dir/bin/herdr"
      chmod +x "$dir/bin/herdr"
      echo "previous contents" > "$dir/clipboard"
      PATH="$dir/bin:$PATH" bash "$launcher" 2>/dev/null
      local rc=$?
      cat "$dir/clipboard"
      return $rc
    }
    When call keep_clipboard
    The status should be failure
    The output should equal "previous contents"
  End

  It "tells a server that is down apart from one reporting no focused pane"
    # Both used to say "no focused pane", which sends you clicking between
    # panes when herdr is the thing that is not answering.
    down() {
      local dir
      dir=$(mktemp -d)
      mkdir -p "$dir/bin"
      printf '%s\n' '#!/bin/sh' '[ "$1 $2" = "notification show" ] && exit 0' 'exit 1' > "$dir/bin/herdr"
      chmod +x "$dir/bin/herdr"
      PATH="$dir/bin:$PATH" bash "$launcher" 2>&1
    }
    When call down
    The status should be failure
    The output should include "herdr is not answering"
  End

  It "refuses when no pane is focused"
    unfocused() {
      local dir
      dir=$(mktemp -d)
      stub_herdr "$dir" '{"result":{"pane":null}}'
      PATH="$dir/bin:$PATH" bash "$launcher" 2>&1
    }
    When call unfocused
    The status should be failure
    The output should include "no focused pane"
  End

  It "falls back past pbcopy to whichever clipboard tool the box has"
    # Nothing in this repo installs wl-copy or xclip, so without an example
    # naming them the fallback order is only ever exercised on a machine that
    # already has one, which is the machine least able to report a break.
    fallback() {
      local dir
      dir=$(mktemp -d)
      stub_herdr "$dir" '{"result":{"pane":{"pane_id":"w9:p2"}}}'
      rm "$dir/bin/pbcopy"
      # Absolute /bin/cat, since PATH below holds only the stub directory.
      printf '%s\n' '#!/bin/sh' "echo \"xclip \$*\" > $dir/clipboard" \
        "/bin/cat >> $dir/clipboard" > "$dir/bin/xclip"
      chmod +x "$dir/bin/xclip"
      # PATH holds only the stubs, so the system pbcopy cannot win the
      # dispatch. jq is linked in because the script still needs it.
      ln -s "$(command -v jq)" "$dir/bin/jq"
      PATH="$dir/bin" /bin/bash "$launcher" || return 1
      cat "$dir/clipboard"
    }
    When call fallback
    The status should be success
    The line 1 of output should equal "xclip -selection clipboard"
  End

  It "raises a toast, since a detached keypress has nowhere else to report"
    toasted() {
      local dir
      dir=$(mktemp -d)
      stub_herdr "$dir" '{"result":{"pane":null}}'
      PATH="$dir/bin:$PATH" bash "$launcher" 2>/dev/null
      cat "$dir/toasts" 2>/dev/null
    }
    When call toasted
    The output should include "Grab scrollback failed"
  End
End
