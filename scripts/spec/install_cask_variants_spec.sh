#!/usr/bin/env bash
# The stub bodies below are written out verbatim, so their expansions are the
# stub's to resolve at run time.
# shellcheck disable=SC2329,SC2016

Describe "install-cask-variants"
  script="$SHELLSPEC_PROJECT_ROOT/install-cask-variants"

  setup() {
    sandbox="$SHELLSPEC_TMPBASE/install-cask-variants"
    rm -rf "$sandbox"
    mkdir -p "$sandbox/bin"
    : > "$sandbox/declared"
    : > "$sandbox/installed"
    printf '{"casks":[{"conflicts_with":{"cask":[]}}]}\n' > "$sandbox/info.json"
    : > "$sandbox/uninstalled"

    # The script only runs on macOS, and the suite runs on Linux too.
    printf '#!/bin/sh\necho Darwin\n' > "$sandbox/bin/uname"

    printf '%s\n' \
      '#!/bin/sh' \
      'case "$1 $2" in' \
      '  "bundle list") cat "$FIXTURES/declared"; [ -f "$FIXTURES/list-nonzero" ] && exit 1; exit 0 ;;' \
      '  "list --cask") cat "$FIXTURES/installed" ;;' \
      '  "info --json=v2") cat "$FIXTURES/info-$4.json" 2>/dev/null || cat "$FIXTURES/info.json" ;;' \
      '  "uninstall --cask") grep -qxF "$3" "$FIXTURES/uninstall-fails" 2>/dev/null && exit 1; echo "$3" >> "$FIXTURES/uninstalled" ;;' \
      'esac' > "$sandbox/bin/brew"

    chmod +x "$sandbox/bin/uname" "$sandbox/bin/brew"

    # macOS ships /usr/bin/jq, so testing the missing-jq path needs a PATH
    # holding only what the script legitimately calls.
    mkdir -p "$sandbox/nojq"
    cp "$sandbox/bin/uname" "$sandbox/bin/brew" "$sandbox/nojq/"
    for tool in sh dirname cut sed grep cat; do
      ln -sf "$(command -v "$tool")" "$sandbox/nojq/$tool"
    done

    export FIXTURES="$sandbox"
  }
  BeforeEach 'setup'

  declared() { printf '%s\n' "$@" > "$sandbox/declared"; }
  installed() { printf '%s\n' "$@" > "$sandbox/installed"; }
  conflicts() {
    printf '{"casks":[{"conflicts_with":{"cask":["%s"]}}]}\n' "$1" > "$sandbox/info.json"
  }
  uninstalled() { cat "$sandbox/uninstalled"; }

  # jq is real; only brew and uname are stubbed.
  run_script() {
    PATH="$sandbox/bin:$PATH" "$script" "$sandbox"
  }

  # jq comes from the brew bundle that runs after this script.
  run_without_jq() {
    PATH="$sandbox/nojq" "$script" "$sandbox"
  }

  It "uninstalls the cask a declared variant supersedes"
    declared ghostty@tip
    installed ghostty
    conflicts ghostty

    When call run_script
    The status should be success
    The output should include "uninstalling ghostty, superseded by ghostty@tip"
    The result of function uninstalled should equal "ghostty"
  End

  It "does nothing when the installed cask is still declared"
    declared ghostty@tip
    installed ghostty@tip

    When call run_script
    The status should be success
    The output should equal ""
    The result of function uninstalled should equal ""
  End

  # Homebrew's own conflict data decides, so the @suffix naming only nominates.
  It "keeps a same-base cask that Homebrew does not report as conflicting"
    declared ghostty@tip
    installed ghostty
    conflicts something-else

    When call run_script
    The status should be success
    The result of function uninstalled should equal ""
  End

  # Aborting mid-run would leave an app uninstalled with its replacement not yet
  # installed, so confirmation for every candidate has to finish first.
  It "uninstalls nothing when a later candidate cannot be confirmed"
    declared ghostty@tip claude-code@latest
    installed ghostty claude-code
    # The first candidate confirms cleanly, so removing before confirming the
    # rest would take ghostty out and then abort on the second.
    printf '{"casks":[{"conflicts_with":{"cask":["ghostty"]}}]}\n' > "$sandbox/info-ghostty@tip.json"
    printf 'not json at all\n' > "$sandbox/info-claude-code@latest.json"

    When call run_script
    The status should be failure
    The stderr should include "cannot read Homebrew metadata"
    The result of function uninstalled should equal ""
  End

  # Unreadable metadata is a different answer from "they don't conflict".
  It "fails rather than skipping when the cask metadata cannot be read"
    declared ghostty@tip
    installed ghostty
    printf 'not json at all\n' > "$sandbox/info.json"

    When call run_script
    The status should be failure
    The stderr should include "cannot read Homebrew metadata for ghostty@tip"
    The stderr should include "brew uninstall --cask ghostty"
    The result of function uninstalled should equal ""
  End

  It "leaves a conflicting cask alone when it is not a variant of a declared one"
    declared docker-desktop
    installed rancher
    conflicts rancher

    When call run_script
    The status should be success
    The result of function uninstalled should equal ""
  End

  # An empty list from a failed lookup is indistinguishable from "nothing is
  # superseded", and the latter exits 0.
  It "fails when the cask lists cannot be enumerated"
    installed ghostty
    : > "$sandbox/declared"
    : > "$sandbox/list-nonzero"

    When call run_script
    The status should be failure
    The stderr should include "cannot enumerate casks"
    The result of function uninstalled should equal ""
  End

  # brew exits nonzero while still printing a complete list when something
  # incidental fails, such as a cache refresh it could not write. A usable list
  # has to win over the status, or bootstrap breaks on a warning.
  It "proceeds when the lookup prints a full list but exits nonzero"
    declared ghostty@tip
    installed ghostty
    conflicts ghostty
    : > "$sandbox/list-nonzero"

    When call run_script
    The status should be success
    The result of function uninstalled should equal "ghostty"
  End

  # Once removal has started, aborting strands an app that brew bundle has not
  # replaced yet, so the run continues and lets bundle report the rest.
  It "keeps going when one uninstall fails"
    declared ghostty@tip claude-code@latest
    installed ghostty claude-code
    printf '{"casks":[{"conflicts_with":{"cask":["ghostty"]}}]}\n' > "$sandbox/info-ghostty@tip.json"
    printf '{"casks":[{"conflicts_with":{"cask":["claude-code"]}}]}\n' > "$sandbox/info-claude-code@latest.json"
    printf 'ghostty\n' > "$sandbox/uninstall-fails"

    When call run_script
    The status should be success
    The stderr should include "could not uninstall ghostty"
    The result of function uninstalled should equal "claude-code"
  End

  It "exits quietly when nothing is installed"
    declared ghostty@tip
    installed

    When call run_script
    The status should be success
    The output should equal ""
  End

  # Skipping quietly here would let brew bundle fail later on the conflict,
  # which is the failure this script exists to prevent.
  It "fails with the manual command when jq is unavailable to confirm"
    declared ghostty@tip
    installed ghostty

    When call run_without_jq
    The status should be failure
    The stderr should include "jq is not available"
    The stderr should include "brew uninstall --cask ghostty"
    The result of function uninstalled should equal ""
  End

  It "does not need jq when there is nothing to retire"
    declared ghostty@tip
    installed ghostty@tip

    When call run_without_jq
    The status should be success
  End
End
