#!/usr/bin/env sh
# Parsing for brew-drift, kept separate so it can be tested without a Homebrew
# installation.

# Read `brew bundle cleanup` output on stdin and print what it would remove, as
# `kind<TAB>token` lines.
#
# The command announces each kind with its own header and then lists its
# entries. The four headers read here are the four kinds this repo's Brewfiles
# declare. Homebrew cleans up VS Code extensions and npm globals under the same
# shape, and naming the headers rather than matching the shape is what keeps a
# manager this repo picks up later from turning the nightly report into an
# extension audit.
#
# Every kind but `mas` lists a bare token per line. Mac App Store apps list as
# `Name (id)`, because a Brewfile entry for one needs both.
#
# Any line matching neither the current kind's shape nor a header ends the
# section, so a trailing blank line or a sentence of Homebrew prose closes it.
# That is what stops the download-cache listing, which follows these sections
# and names paths, from reading as packages.
brew_drift_parse() {
  awk '
    /^Would uninstall formulae:/           { kind = "formula"; next }
    /^Would uninstall casks:/              { kind = "cask";    next }
    /^Would uninstall Mac App Store apps:/ { kind = "mas";     next }
    /^Would untap:/                        { kind = "tap";     next }

    kind == "mas" && /^.+ \([0-9]+\)$/ { print kind "\t" $0; next }
    kind != "" && kind != "mas" && /^[A-Za-z0-9][A-Za-z0-9@+._\/-]*$/ {
      print kind "\t" $0
      next
    }

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
    $1 == "tap"     { printf "tap '\''%s'\''\n",  $2; next }

    $1 == "mas" && match($2, /\([0-9]+\)$/) {
      printf "mas '\''%s'\'', id: %s\n", \
        substr($2, 1, RSTART - 2), substr($2, RSTART + 1, RLENGTH - 2)
      next
    }
  '
}
