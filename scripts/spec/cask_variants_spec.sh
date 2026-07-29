#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "cask-variants.sh"
  setup() {
    # shellcheck source=/dev/null
    source "$SHELLSPEC_PROJECT_ROOT/lib/cask-variants.sh"
  }
  BeforeEach 'setup'

  Describe "cask_variants_superseded"
    It "pairs an installed cask with the declared variant that replaces it"
      When call cask_variants_superseded "ghostty@tip" "ghostty"
      The status should be success
      The output should equal "$(printf 'ghostty\tghostty@tip')"
    End

    It "retires a variant when the Brewfile moves back to the plain cask"
      When call cask_variants_superseded "ghostty" "ghostty@tip"
      The output should equal "$(printf 'ghostty@tip\tghostty')"
    End

    It "leaves a cask alone while it is still declared"
      When call cask_variants_superseded "ghostty@tip" "ghostty@tip"
      The output should equal ""
    End

    It "ignores an installed cask with no declared sibling"
      When call cask_variants_superseded "ghostty@tip" "rancher"
      The output should equal ""
    End

    It "does not treat a conflicting unrelated app as a sibling"
      # docker-desktop declares conflicts_with rancher, but they share no base
      # token, so the variant rule must not select it.
      When call cask_variants_superseded "docker-desktop" "rancher"
      The output should equal ""
    End

    It "matches on the whole base token, not a prefix"
      When call cask_variants_superseded "docker-desktop" "docker"
      The output should equal ""
    End

    It "selects only the superseded entries out of a mixed list"
      declared=$(printf 'ghostty@tip\nclaude-code@latest\nfirefox')
      installed=$(printf 'ghostty\nfirefox\nclaude-code')

      When call cask_variants_superseded "$declared" "$installed"
      The line 1 should equal "$(printf 'ghostty\tghostty@tip')"
      The line 2 should equal "$(printf 'claude-code\tclaude-code@latest')"
      The lines of output should equal 2
    End

    It "handles an empty installed list"
      When call cask_variants_superseded "ghostty@tip" ""
      The output should equal ""
    End
  End
End
