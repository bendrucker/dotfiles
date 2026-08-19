#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "terminal glyphs"
  glyph_scan() { "$SHELLSPEC_PROJECT_ROOT/../bin/glyph-scan" "$@"; }

  font="$HOME/Library/Fonts/MonaspiceNeNerdFontMono-Regular.otf"
  font_missing() { [ ! -f "$font" ]; }

  It "declares every private-use glyph used in a tracked file"
    When call glyph_scan
    The status should be success
    The stderr should equal ""
  End

  It "renders every declared glyph in the installed font"
    Skip if "the font cask is not installed" font_missing
    When call glyph_scan --font
    The status should be success
    The stderr should equal ""
  End

  # The scan reads `git ls-files` from whatever repo it is run in, so a scratch
  # repo is what lets these two assert the same glyph in two places.
  scratch_repo() {
    local repo="$SHELLSPEC_TMPBASE/glyph-scan-$1"
    rm -rf "$repo"
    mkdir -p "$repo/terminal" "$repo/herdr/agent-detection/screens/claude"
    git -C "$repo" init -q
    printf '# no declarations\n' >"$repo/terminal/glyphs.conf"
    printf '\xf3\xb0\xaa\x9f\n' >"$repo/$2"
    git -C "$repo" add -A
    (cd "$repo" && "$SHELLSPEC_PROJECT_ROOT/../bin/glyph-scan" 2>&1)
  }

  It "reports an undeclared glyph in a file this repo renders"
    When call scratch_repo rendered terminal/tmux.conf
    The status should be failure
    The output should include "U+F0A9F"
  End

  # A capture is another program's glyph choice, recorded verbatim. Scanning it
  # would fail this repo's lint for something it cannot change, and recapturing
  # a screen would need a declaration for whatever the program drew that day.
  It "leaves a captured screen alone"
    When call scratch_repo captured herdr/agent-detection/screens/claude/pane.txt
    The status should be success
    The output should equal ""
  End
End
