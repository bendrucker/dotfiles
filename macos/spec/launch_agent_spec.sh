#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "launch_agent_plan"
  Include lib/launch-agent.sh

  Describe "for every combination of inputs"
    Parameters
      # unchanged loaded is_self  plan
      1 1 0 skip
      1 1 1 skip
      1 0 0 bootstrap
      1 0 1 bootstrap
      0 1 0 reinstall
      0 1 1 defer
      0 0 0 bootstrap
      0 0 1 bootstrap
    End

    It "plans $4 when unchanged=$1 loaded=$2 is_self=$3"
      When call launch_agent_plan "$1" "$2" "$3"
      The status should be success
      The output should equal "$4"
    End
  End

  It "never boots out the job this process runs under"
    plans_for_self() {
      local unchanged loaded
      for unchanged in 0 1; do
        for loaded in 0 1; do
          launch_agent_plan "$unchanged" "$loaded" 1
        done
      done
    }
    When call plans_for_self
    The output should not include "reinstall"
  End

  It "reloads a job whose plist is installed but unloaded"
    When call launch_agent_plan 1 0 0
    The output should equal "bootstrap"
  End
End
