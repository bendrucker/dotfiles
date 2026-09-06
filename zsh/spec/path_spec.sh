#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016

Describe "PATH"
  root=$(cd "$SHELLSPEC_PROJECT_ROOT/.." && pwd)

  # Read out of the path.zsh files rather than listed here, so a topic added
  # later is covered without touching this spec. The set spans mise on both
  # sides: herdr sorts before it, theme and tmux after.
  topic_bins() {
    grep -ho '\$ZSH/[A-Za-z0-9_.-]*/bin' "$root"/*/path.zsh | sort -u | sed "s|\\\$ZSH|$root|"
  }

  # $PATH one entry per line, as a shell of the given shape built it. The shell
  # writes to a file because terminal integration prefixes stdout with escapes.
  #
  # A shell reads its per-user .zshenv from $ZDOTDIR when that is set, so what
  # the directory holds decides whether the path.zsh loop runs at all.
  path_of() {
    local zdotdir out
    zdotdir=$(mktemp -d)
    out=$(mktemp)
    for file in "$@"; do
      ln -s "$root/zsh/$file" "$zdotdir/$file"
    done
    ZDOTDIR="$zdotdir" DOTFILES_USE_DEV="$root" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
      zsh -i -c "print -l \$path > $out" </dev/null >/dev/null 2>&1
    cat "$out"
    rm -rf "$zdotdir" "$out"
  }

  missing_from() {
    local built="$1" bin rc=0
    while read -r bin; do
      grep -qxF "$bin" <<<"$built" || { echo "$bin"; rc=1; }
    done < <(topic_bins)
    return $rc
  }

  Describe "in a shell that reads no .zshenv"
    # zsh/symlinks.conf installs only .zshrc under $ZDOTDIR, and .zshenv exports
    # ZDOTDIR, so this is every zsh below the first one: a pane, or anything a
    # long-lived server spawns. Such a shell used to keep whatever PATH its
    # parent froze, which for a server started before a topic existed never held
    # that topic's bin. PATH here arrives without any of them to stand in for
    # that.
    built=""

    setup() { built=$(path_of .zshrc); }
    BeforeAll "setup"

    It "still puts every topic's bin on it"
      When call missing_from "$built"
      The status should be success
      The output should equal ""
    End

    It "still keeps the repo's own bin first"
      first_entry() { head -1 <<<"$built"; }
      When call first_entry
      The output should equal "$root/bin"
    End
  End

  Describe "in a shell that reads one"
    built=""

    setup() { built=$(path_of .zshenv .zshrc); }
    BeforeAll "setup"

    It "puts every topic's bin on it"
      When call missing_from "$built"
      The status should be success
      The output should equal ""
    End

    It "builds it once, rather than rebuilding over the top"
      count_duplicates() { sort <<<"$built" | uniq -d; }
      When call count_duplicates
      The output should equal ""
    End
  End

  It "does not export the marker the rebuild keys on"
    # An exported marker would let a child shell read its parent's startup as
    # its own and skip the rebuild it needs, which is the whole bug again.
    leaked() {
      zsh -fc "source '$root/zsh/.zshenv' >/dev/null 2>&1
               zsh -fc 'echo \${DOTFILES_ZSHENV_RAN:-unset}'"
    }
    When call leaked
    The output should equal "unset"
  End
End
