#!/usr/bin/env sh
# Parsing for brew-drift, kept separate so it can be tested without a Homebrew
# installation.

# Read `brew bundle cleanup` output on stdin and print what it would remove, as
# `kind<TAB>token` lines. The four headers matched are the four kinds this
# repo's Brewfiles declare. Package Drift in CLAUDE.md covers why the others
# are left out.
#
# Every kind but `mas` lists a bare token per line. Mac App Store apps list as
# `Name (id)`, because a Brewfile entry for one needs both.
#
# A line matching neither the current kind's shape nor a header ends the
# section. That is what stops the download-cache listing, which follows these
# sections and names paths, from reading as packages.
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
# them, because the action a report leads to is pasting the line into a topic
# Brewfile.
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
