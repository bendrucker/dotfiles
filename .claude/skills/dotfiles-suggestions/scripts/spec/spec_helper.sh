#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2329

shellspec_spec_helper_configure() {
  SCRIPTS_DIR="$SHELLSPEC_SPECDIR/.."

  setup_fixture() {
    FIXTURE_DIR=$(mktemp -d)
    HISTFILE="$FIXTURE_DIR/history"
    cat > "$HISTFILE" << 'FIXTURE'
: 1700000000:0;git status
: 1700000100:0;git commit -m 'initial'
: 1700000200:0;git push --force
: 1700000300:0;git status
: 1700000400:0;docker build -t app .
: 1700000500:0;git log --oneline
: 1700000600:0;npm test && npm run build
: 1700000700:0;git add . && git commit -m 'fix'
: 1700000800:0;cat foo | grep bar
: 1700000900:0;git status
: 1700001000:0;c++ -o main main.cpp
: 1700001100:0;./run.sh
continuation line without timestamp prefix
: 1700001200:0;git push
FIXTURE
  }

  cleanup_fixture() {
    rm -rf "$FIXTURE_DIR"
  }
}
