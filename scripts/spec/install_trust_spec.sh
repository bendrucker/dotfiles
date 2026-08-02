#!/usr/bin/env bash
# The stub body below is written out verbatim, so its expansions are the
# stub's to resolve at run time.
# shellcheck disable=SC2329,SC2016

Describe "install-trust"
  script="$SHELLSPEC_PROJECT_ROOT/install-trust"

  setup() {
    sandbox="$SHELLSPEC_TMPBASE/install-trust"
    rm -rf "$sandbox"
    mkdir -p "$sandbox/bin" "$sandbox/repo/Library/Taps" "$sandbox/config/homebrew"
    : > "$sandbox/declared"
    : > "$sandbox/tapped"
    : > "$sandbox/trusted"
    printf '%s\n' "$sandbox/repo" > "$sandbox/repository"

    trust_json="$sandbox/config/homebrew/trust.json"
    # The fallback spec empties this to exercise the brew --repository path.
    repository="$sandbox/repo"

    # Each invocation appends one line, so the specs can count calls as well
    # as check arguments.
    printf '%s\n' \
      '#!/bin/sh' \
      'case "$1" in' \
      '  bundle) cat "$FIXTURES/declared" ;;' \
      '  --repository) cat "$FIXTURES/repository" ;;' \
      '  tap) echo "$2" >> "$FIXTURES/tapped" ;;' \
      '  trust) shift; echo "$*" >> "$FIXTURES/trusted" ;;' \
      'esac' > "$sandbox/bin/brew"
    chmod +x "$sandbox/bin/brew"

    export FIXTURES="$sandbox"
  }
  BeforeEach 'setup'

  declared() { printf '%s\n' "$@" > "$sandbox/declared"; }
  installed() {
    for tap in "$@"; do
      mkdir -p "$sandbox/repo/Library/Taps/${tap%%/*}/homebrew-${tap#*/}"
    done
  }
  shallow() { mkdir -p "$sandbox/repo/Library/Taps/${1%%/*}/homebrew-${1#*/}/.git" && : > "$sandbox/repo/Library/Taps/${1%%/*}/homebrew-${1#*/}/.git/shallow"; }
  stale_trust() { printf '{"trustedtaps":["gone/away"]}\n' > "$trust_json"; }
  tapped() { cat "$sandbox/tapped"; }
  trusted() { cat "$sandbox/trusted"; }

  run_script() {
    PATH="$sandbox/bin:$PATH" \
      HOMEBREW_REPOSITORY="$repository" \
      XDG_CONFIG_HOME="$sandbox/config" \
      "$script" "$sandbox"
  }

  # The steady-state run: no `brew tap` calls at all, only the bundle list and
  # one batched trust.
  It "does not tap a repository that is already on disk"
    declared oven-sh/bun schpet/tap
    installed oven-sh/bun schpet/tap

    When call run_script
    The status should be success
    The result of function tapped should equal ""
  End

  It "taps only the repositories missing from disk"
    declared oven-sh/bun schpet/tap
    installed oven-sh/bun

    When call run_script
    The status should be success
    The result of function tapped should equal "schpet/tap"
  End

  It "matches the downcased tap directory Homebrew installs into"
    declared Oven-SH/Bun
    installed oven-sh/bun

    When call run_script
    The status should be success
    The result of function tapped should equal ""
  End

  It "trusts every declared tap in a single call"
    declared oven-sh/bun schpet/tap pulumi/tap
    installed oven-sh/bun schpet/tap pulumi/tap

    When call run_script
    The status should be success
    The result of function trusted should equal "--tap oven-sh/bun schpet/tap pulumi/tap"
  End

  It "rebuilds the trust file from scratch so a dropped tap drops out"
    stale_trust
    declared oven-sh/bun
    installed oven-sh/bun

    When call run_script
    The status should be success
    The path "$trust_json" should not be exist
    The result of function trusted should equal "--tap oven-sh/bun"
  End

  # `brew trust` with no targets prints the trusted list instead of writing it.
  It "clears the trust file without calling trust when nothing is declared"
    stale_trust

    When call run_script
    The status should be success
    The path "$trust_json" should not be exist
    The result of function trusted should equal ""
  End

  It "falls back to asking brew for the repository path"
    declared oven-sh/bun
    installed oven-sh/bun
    repository=""

    When call run_script
    The status should be success
    The result of function tapped should equal ""
  End

  # `brew tap` is only a no-op on a tap that is installed and not shallow. On a
  # shallow one it is what runs `git fetch --unshallow`.
  It "taps a repository whose clone on disk is shallow"
    declared oven-sh/bun
    installed oven-sh/bun
    shallow oven-sh/bun

    When call run_script
    The status should be success
    The result of function tapped should equal "oven-sh/bun"
  End
End
