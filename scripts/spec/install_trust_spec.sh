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
  trust_file() { echo "$sandbox/config/homebrew/trust.json"; }
  tapped() { cat "$sandbox/tapped"; }
  trusted() { cat "$sandbox/trusted"; }

  run_script() {
    PATH="$sandbox/bin:$PATH" \
      HOMEBREW_REPOSITORY="$sandbox/repo" \
      XDG_CONFIG_HOME="$sandbox/config" \
      "$script" "$sandbox"
  }

  # The whole point of the directory check: a warm machine makes no `brew tap`
  # calls at all, only the bundle list and one batched trust.
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
    printf '{"trustedtaps":["gone/away"]}\n' > "$(trust_file)"
    declared oven-sh/bun
    installed oven-sh/bun

    When call run_script
    The status should be success
    The path "$sandbox/config/homebrew/trust.json" should not be exist
    The result of function trusted should equal "--tap oven-sh/bun"
  End

  # `brew trust` with no targets prints the trusted list instead of writing it.
  It "clears the trust file without calling trust when nothing is declared"
    printf '{"trustedtaps":["gone/away"]}\n' > "$(trust_file)"

    When call run_script
    The status should be success
    The path "$sandbox/config/homebrew/trust.json" should not be exist
    The result of function trusted should equal ""
  End

  It "falls back to asking brew for the repository path"
    declared oven-sh/bun
    installed oven-sh/bun

    When call env PATH="$sandbox/bin:$PATH" XDG_CONFIG_HOME="$sandbox/config" HOMEBREW_REPOSITORY= "$script" "$sandbox"
    The status should be success
    The result of function tapped should equal ""
  End
End
