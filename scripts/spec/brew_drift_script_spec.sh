#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016

Describe "brew-drift"
  brew_drift="$SHELLSPEC_PROJECT_ROOT/brew-drift"

  setup() {
    sandbox="$SHELLSPEC_TMPBASE/brew-drift"
    root="$sandbox/dotfiles"
    stubdir="$sandbox/stub"
    rm -rf "$sandbox"
    mkdir -p "$stubdir" "$root"
    : >"$root/Brewfile"
  }

  BeforeEach 'setup'

  # `brew bundle cleanup` prints the listing and then asks whether to uninstall.
  # This stub reproduces both halves. Whatever it reads from stdin is what a
  # person's "y" would have been, and it lands in a file the test can read
  # because the answer never reaches the script's own stdout.
  stub_brew() {
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      'printf "Would uninstall formulae:\ncmake\n"' \
      "read -r answer && printf '%s' \"\$answer\" >'$sandbox/answered'" \
      'exit 1' \
      >"$stubdir/brew"
    chmod +x "$stubdir/brew"
  }

  prompt_answer() { cat "$sandbox/answered" 2>/dev/null || printf unanswered; }

  run_drift() { PATH="$stubdir:$PATH" "$brew_drift" "$root"; }

  # Regression: without --force the command prompts rather than reporting, so a
  # run that leaves stdin open is one keystroke from uninstalling every
  # undeclared package. Closing stdin is what makes this a read.
  It "denies brew the stdin its uninstall prompt reads"
    stub_brew

    Data "y"
    When call run_drift
    The output should equal "brew 'cmake'"
    The result of function prompt_answer should equal "unanswered"
  End

  It "reports the packages the cleanup listing names"
    stub_brew

    When call run_drift
    The output should equal "brew 'cmake'"
  End

  It "fails loudly when the cleanup produces nothing to read"
    printf '#!/usr/bin/env bash\nexit 1\n' >"$stubdir/brew"
    chmod +x "$stubdir/brew"

    When run run_drift
    The status should equal 1
    The stderr should include "would go unnoticed"
  End

  It "stays silent when the machine matches the Brewfile"
    printf '#!/usr/bin/env bash\nprintf "Using cmake\\n"\n' >"$stubdir/brew"
    chmod +x "$stubdir/brew"

    When call run_drift
    The output should equal ""
  End

  # CI and a fresh machine both reach this before Homebrew exists. The system
  # paths stay on PATH so the script's own interpreter still resolves. Homebrew
  # installs to neither of them.
  run_without_brew() { PATH="/usr/bin:/bin" "$brew_drift" "$root"; }

  It "reports nothing when brew is absent"
    When call run_without_brew
    The status should equal 0
    The output should equal ""
  End
End
