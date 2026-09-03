#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "brew-drift.sh"
  setup() {
    # shellcheck source=/dev/null
    source "$SHELLSPEC_PROJECT_ROOT/lib/brew-drift.sh"
  }
  BeforeEach 'setup'

  Describe "brew_drift_parse"
    It "labels the formulae under the formula header"
      Data
        #|Would uninstall formulae:
        #|cmake
        #|ninja
      End

      When call brew_drift_parse
      The line 1 should equal "$(printf 'formula\tcmake')"
      The line 2 should equal "$(printf 'formula\tninja')"
      The lines of output should equal 2
    End

    It "switches label when the cask header follows the formula list"
      Data
        #|Would uninstall formulae:
        #|tree
        #|
        #|Would uninstall casks:
        #|visual-studio-code@insiders
      End

      When call brew_drift_parse
      The line 1 should equal "$(printf 'formula\ttree')"
      The line 2 should equal "$(printf 'cask\tvisual-studio-code@insiders')"
      The lines of output should equal 2
    End

    # A bare package name reappears inside the cache listing, so the section
    # has to close rather than merely skip the prose lines.
    It "stops before the download cache listing"
      Data
        #|Would uninstall formulae:
        #|cmake
        #|
        #|Would `brew cleanup`:
        #|Would remove: /opt/homebrew/Cellar/aws-c-auth/0.10.4 (19 files, 418.1KB)
        #|ninja
      End

      When call brew_drift_parse
      The output should equal "$(printf 'formula\tcmake')"
    End

    # These appear only on a Brewfile that declares them, which is what a
    # `vscode` line added later would do.
    It "ignores managers this repo does not declare"
      Data
        #|Would uninstall VS Code extensions:
        #|ms-python.python
        #|Would uninstall npm packages:
        #|typescript
      End

      When call brew_drift_parse
      The output should equal ""
    End

    It "reports nothing for output with no uninstall sections"
      Data
        #|Would `brew cleanup`:
        #|Would remove: /opt/homebrew/Cellar/aws-c-auth/0.10.4 (19 files, 418.1KB)
      End

      When call brew_drift_parse
      The output should equal ""
    End

    It "labels the taps under the untap header"
      Data
        #|Would untap:
        #|hashicorp/tap
        #|minamijoyo/tfschema
      End

      When call brew_drift_parse
      The line 1 should equal "$(printf 'tap\thashicorp/tap')"
      The line 2 should equal "$(printf 'tap\tminamijoyo/tfschema')"
      The lines of output should equal 2
    End

    It "keeps the name and id of a Mac App Store app together"
      Data
        #|Would uninstall Mac App Store apps:
        #|Xcode (497799835)
        #|1Password for Safari (1569813296)
      End

      When call brew_drift_parse
      The line 1 should equal "$(printf 'mas\tXcode (497799835)')"
      The line 2 should equal "$(printf 'mas\t1Password for Safari (1569813296)')"
      The lines of output should equal 2
    End

    # The app section is the one whose entries carry spaces, so its shape is
    # the one that could swallow the prose following it.
    It "closes the app section on a line that is not an app"
      Data
        #|Would uninstall Mac App Store apps:
        #|Xcode (497799835)
        #|
        #|Would `brew cleanup`:
        #|Would remove: /opt/homebrew/Cellar/aws-c-auth/0.10.4 (19 files, 418.1KB)
      End

      When call brew_drift_parse
      The output should equal "$(printf 'mas\tXcode (497799835)')"
    End

    It "keeps the punctuation Homebrew allows in a token"
      Data
        #|Would uninstall casks:
        #|logi-options+
        #|font-monaspice-nerd-font
        #|Would uninstall formulae:
        #|postgresql@17
        #|agavra/tap/tuicr
      End

      When call brew_drift_parse
      The line 1 should equal "$(printf 'cask\tlogi-options+')"
      The line 2 should equal "$(printf 'cask\tfont-monaspice-nerd-font')"
      The line 3 should equal "$(printf 'formula\tpostgresql@17')"
      The line 4 should equal "$(printf 'formula\tagavra/tap/tuicr')"
    End
  End

  Describe "brew_drift_format"
    It "renders each kind as the Brewfile entry that would declare it"
      Data
        #|formula	cmake
        #|cask	logi-options+
        #|tap	hashicorp/tap
      End

      When call brew_drift_format
      The line 1 should equal "brew 'cmake'"
      The line 2 should equal "cask 'logi-options+'"
      The line 3 should equal "tap 'hashicorp/tap'"
    End

    It "splits a Mac App Store app back into a name and an id"
      Data
        #|mas	Xcode (497799835)
        #|mas	1Password for Safari (1569813296)
      End

      When call brew_drift_format
      The line 1 should equal "mas 'Xcode', id: 497799835"
      The line 2 should equal "mas '1Password for Safari', id: 1569813296"
    End

    It "produces nothing for empty input"
      Data ""

      When call brew_drift_format
      The output should equal ""
    End
  End
End
