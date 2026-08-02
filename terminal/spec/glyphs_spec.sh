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
End
