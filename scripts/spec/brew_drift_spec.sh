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

    # The cache listing follows the package sections and names paths that would
    # otherwise read as tokens. Its own entries are prose, but a bare package
    # name reappears in it, so the section has to close rather than merely skip
    # lines that don't look like tokens.
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

    # Homebrew cleans up VS Code extensions and npm globals too, on a Brewfile
    # that declares them. Reading only the two package headers is what keeps
    # those out, so a Brewfile that grows a `vscode` line later cannot turn the
    # nightly report into an extension audit.
    It "ignores managers other than formulae and casks"
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
      End

      When call brew_drift_format
      The line 1 should equal "brew 'cmake'"
      The line 2 should equal "cask 'logi-options+'"
    End

    It "produces nothing for empty input"
      Data ""

      When call brew_drift_format
      The output should equal ""
    End
  End
End
