#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016

Describe "herdr-claude-agents"
  launcher="$SHELLSPEC_PROJECT_ROOT/bin/herdr-claude-agents"
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
    When call launcher_on_path herdr-claude-agents
    The status should be success
  End

  It "binds the launcher by the name PATH exports"
    When call grep -q 'command = "herdr-claude-agents"' "$config"
    The status should be success
  End

  It "refuses without claude on PATH"
    refuse() {
      PATH=/usr/bin:/bin bash "$launcher" 2>&1
    }
    When call refuse
    The status should be failure
    The output should include "not on PATH"
  End

  stub_claude() {
    local stub="$1"
    mkdir -p "$stub"
    printf '%s\n' '#!/bin/sh' 'echo "$*"' > "$stub/claude"
    chmod +x "$stub/claude"
  }

  It "folds every CLAUDE_AGENTS_ADD_DIR entry into its own --add-dir"
    # The view dispatches sessions, and each one inherits only the dirs named
    # here, so a dropped entry silently narrows what those sessions may read.
    fold() {
      local stub
      stub=$(mktemp -d)/bin
      stub_claude "$stub"
      CLAUDE_AGENTS_ADD_DIR="/a:/b" PATH="$stub:$PATH" bash "$launcher"
    }
    When call fold
    The status should be success
    The output should equal "agents --add-dir /a --add-dir /b"
  End

  It "drops the empty entry a trailing colon leaves behind"
    trailing() {
      local stub
      stub=$(mktemp -d)/bin
      stub_claude "$stub"
      CLAUDE_AGENTS_ADD_DIR="/a:" PATH="$stub:$PATH" bash "$launcher"
    }
    When call trailing
    The status should be success
    The output should equal "agents --add-dir /a"
  End

  It "passes no flags when the variable is unset"
    bare() {
      local stub
      stub=$(mktemp -d)/bin
      stub_claude "$stub"
      env -u CLAUDE_AGENTS_ADD_DIR PATH="$stub:$PATH" bash "$launcher"
    }
    When call bare
    The status should be success
    The output should equal "agents"
  End
End
