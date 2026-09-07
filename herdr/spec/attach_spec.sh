#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016

Describe "herdr-attach"
  launcher="$SHELLSPEC_PROJECT_ROOT/bin/herdr-attach"

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
    When call launcher_on_path herdr-attach
    The status should be success
  End

  It "refuses without herdr on PATH"
    refuse() {
      PATH=/usr/bin:/bin bash "$launcher" anything 2>&1
    }
    When call refuse
    The status should be failure
    The output should include "not on PATH"
  End

  # The whole point of this launcher is that it never becomes a second full app
  # client, which is what turns off herdr's direct-kitty graphics for the
  # desktop and silently breaks the mouse in terminal-browser and tode panes.
  # `terminal attach` connects in a mode the client count excludes; plain
  # `herdr` does not.
  It "attaches over the terminal path rather than starting an app client"
    When call grep -q '^exec herdr terminal attach' "$launcher"
    The status should be success
  End

  stub_herdr() {
    local stub="$1"
    mkdir -p "$stub"
    cat > "$stub/herdr" <<'STUB'
#!/bin/sh
case "$1 $2" in
  "pane list")
    printf '%s' '{"result":{"panes":[
      {"pane_id":"wA:p1","terminal_id":"term_a","agent_status":"idle","terminal_title_stripped":"a shell"},
      {"pane_id":"wB:p1","terminal_id":"term_b","agent_status":"done","terminal_title_stripped":"an agent"}]}}'
    ;;
  "agent list")
    printf '%s' '{"result":{"agents":[{"pane_id":"wB:p1","name":"shipper"}]}}'
    ;;
  "terminal attach")
    shift 2
    echo "attach $*"
    ;;
esac
STUB
    chmod +x "$stub/herdr"
  }

  attach() {
    local stub
    stub=$(mktemp -d)/bin
    stub_herdr "$stub"
    PATH="$stub:$PATH" bash "$launcher" "$@"
  }

  It "resolves an agent name to that agent's terminal"
    # The name is the only handle worth typing on a phone keyboard, and it
    # lives on the agent list rather than the pane list.
    When call attach shipper
    The status should be success
    The output should equal "attach term_b"
  End

  It "resolves a pane id"
    When call attach wA:p1
    The status should be success
    The output should equal "attach term_a"
  End

  It "resolves a terminal id"
    When call attach term_b
    The status should be success
    The output should equal "attach term_b"
  End

  It "passes --takeover through"
    # A dropped mosh link leaves its client holding the terminal, so reclaiming
    # one is the ordinary case rather than the exception.
    When call attach --takeover shipper
    The status should be success
    The output should equal "attach term_b --takeover"
  End

  It "rejects a target matching no pane, terminal, or agent"
    When call attach nonesuch
    The status should be failure
    The stderr should include "no pane id, terminal id, or agent name"
  End

  It "reports a server that is not running"
    silent() {
      local stub
      stub=$(mktemp -d)/bin
      mkdir -p "$stub"
      printf '%s\n' '#!/bin/sh' 'exit 1' > "$stub/herdr"
      chmod +x "$stub/herdr"
      PATH="$stub:$PATH" bash "$launcher" shipper
    }
    When call silent
    The status should be failure
    The stderr should include "no herdr server is running"
  End
End
