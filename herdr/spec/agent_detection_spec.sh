#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016

Describe "herdr-agent-detection"
  # What each pattern in the overlay matches, read out of the overlay itself
  # rather than from a copy that can drift from it.
  #
  # This says nothing about what herdr does with the rules the patterns sit in.
  # An earlier version of this suite was only these tests, and passed against a
  # rule that matched nothing at all: the two spinner shapes had been written as
  # two entries of one `line_regex`, and herdr ANDs the matchers within a rule,
  # so it demanded a screen holding both lines at once. The screen corpus under
  # `herdr/agent-detection/screens/claude`, which `bin/herdr-agent-detection.test.ts`
  # has herdr score, is what covers that. These cover the lookalikes no screen
  # capture holds, and they need nothing installed, so they are the part that
  # runs on a CI box that has never started herdr.
  #
  # Every fixture below carries a leading `|>` that the test strips. Without it
  # this file would hold spinner lines at column 0, which is exactly what the
  # rules match, and reading it in a pane would pin that pane at working while it
  # sat idle. A test for a screen-scraping rule has to stay off the screen. Two
  # characters, not one: a bare `|` before an indented fixture reproduces the
  # `<non-space><space>` opening the first rule keys on, and matches again.
  overlay_patterns() {
    awk -v want="$1" '
      /^not = \[/ { guard = 1 }
      /^\]$/ { guard = 0; next }
      guard == want
    ' "$SHELLSPEC_PROJECT_ROOT/agent-detection/claude.toml" |
      sed -n "s/.*line_regex = \['\(.*\)'\].*/\1/p"
  }

  # Any one pattern matching is the answer, because herdr ORs the branches of an
  # `any` block and the entries of a `not` block alike.
  matches_any() {
    local line="$1" patterns="$2" rx
    while IFS= read -r rx; do
      [ -n "$rx" ] || continue
      printf '%s\n' "$line" | rg -q "$rx" && return 0
    done <<PATTERNS
$patterns
PATTERNS
    return 1
  }

  It "matches every form of the live spinner line"
    spinner_lines_match() {
      local patterns line
      patterns=$(overlay_patterns 0)
      [ -n "$patterns" ] || { echo "no working line_regex found in the overlay"; return 1; }
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        line=${line#|>}
        matches_any "$line" "$patterns" ||
          { echo "should have matched: $line"; return 1; }
      done <<'LINES'
|>✻ Crunching… (18m 20s · ↓ 53.5k tokens)
|>✢ Twisting… (56s · ↓ 1.0k tokens)
|>✽ Thinking… (1h 2m 3s · ↓ 900 tokens)
|>✻ Crunching… (esc to interrupt)
|>✻ Waiting for 2 background agents to finish
|>✻ Waiting for 1 dynamic workflow to finish
|>  ◯ 󰚩 Running python3 · 10m 24s · 57.6k
|>  ◯ writing-cleanup  You are cleaning up… 14s · ↓ 40.5k tokens
LINES
    }
    When call spinner_lines_match
    The status should be success
  End

  # A pane pinned at working while idle is worse than the flapping being fixed,
  # so these are the cases that matter most. Each is a real line seen in a Claude
  # Code pane, or the spinner quoted in prose the way this repo's own commit
  # message quotes it.
  It "does not match transcript text that merely looks like a spinner"
    lookalikes_reject() {
      local patterns line
      patterns=$(overlay_patterns 0)
      [ -n "$patterns" ] || { echo "no working line_regex found in the overlay"; return 1; }
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        line=${line#|>}
        matches_any "$line" "$patterns" &&
          { echo "should not have matched: $line"; return 1; }
      done <<'LINES'
|>  ✻ Crunching… (18m 20s · ↓ 53.5k tokens)
|>❯ ✻ Crunching… (18m 20s · ↓ 53.5k tokens)
|>❯ ✻ Crunching… (esc to interrupt)
|>- Building… (2m 10s elapsed)
|>⏺ Downloading model weights… (4m remaining)
|>⏺ Running 4 shell commands…
|>✻ Churned for 33m 23s
|>  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
|>  ◯ writing-cleanup  Ran the suite in 12s · 5 files chang… idle
LINES
      return 0
    }
    When call lookalikes_reject
    The status should be success
  End

  # The guards decide whether the rules above stand down, and they are the half
  # that fails silently: a guard that stops firing reports working on a pane
  # waiting for a person, and every screen that is not a prompt still scores the
  # same. The two shapes are Claude Code's numbered permission prompts and its
  # arrow-key pickers, which carry no digits at all.
  It "stands down on every selection Claude Code draws"
    pickers_disqualify() {
      local patterns line
      patterns=$(overlay_patterns 1)
      [ -n "$patterns" ] || { echo "no guard line_regex found in the overlay"; return 1; }
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        line=${line#|>}
        matches_any "$line" "$patterns" ||
          { echo "should have disqualified: $line"; return 1; }
      done <<'LINES'
|>  ❯ 1. Yes
|>   ❯ 1. Yes, and don't ask again
|>  ❯ Sonnet
|>  ❯ Dark mode
LINES
    }
    When call pickers_disqualify
    The status should be success
  End

  # The input box draws the same glyph at column 0 and carries whatever has been
  # typed there. A guard that fired on it would stand the rules down on any pane
  # with text in the box while the agent works.
  It "does not stand down on the input box"
    input_box_allows() {
      local patterns line
      patterns=$(overlay_patterns 1)
      [ -n "$patterns" ] || { echo "no guard line_regex found in the overlay"; return 1; }
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        line=${line#|>}
        matches_any "$line" "$patterns" &&
          { echo "should not have disqualified: $line"; return 1; }
      done <<'LINES'
|>❯ Use the Bash tool to run exactly: curl
|>❯ 1. why does this keep happening
LINES
      return 0
    }
    When call input_box_allows
    The status should be success
  End
End
