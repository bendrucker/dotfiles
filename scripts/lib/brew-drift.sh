#!/usr/bin/env sh
# Parsing for brew-drift, kept separate so it can be tested without a Homebrew
# installation.

# Read `brew bundle cleanup` dry-run output on stdin and print the packages it
# would uninstall, as `kind<TAB>token` lines.
#
# The dry run announces each kind with its own header and then lists one bare
# token per line. Reading only the formula and cask headers is what keeps the
# report to packages: the same command also offers to prune the download cache
# and, on a Brewfile that declares them, VS Code extensions and npm globals.
# Selecting the two headers means a manager this repo picks up later cannot
# silently turn the nightly report into an extension audit.
#
# Any line that is not a bare token ends the current section, so a trailing
# blank line, the next header, or a sentence of Homebrew prose all close it.
brew_drift_parse() {
  awk '
    /^Would uninstall formulae:/ { kind = "formula"; next }
    /^Would uninstall casks:/    { kind = "cask";    next }
    kind != "" && /^[A-Za-z0-9][A-Za-z0-9@+._\/-]*$/ { print kind "\t" $0; next }
    { kind = "" }
  '
}

# Render `kind<TAB>token` lines as the Brewfile entries that would declare
# them. The report exists to be acted on, and the action is pasting a line
# into a topic Brewfile, so print the line.
brew_drift_format() {
  awk -F'\t' '
    $1 == "formula" { printf "brew '\''%s'\''\n", $2; next }
    $1 == "cask"    { printf "cask '\''%s'\''\n", $2; next }
  '
}
