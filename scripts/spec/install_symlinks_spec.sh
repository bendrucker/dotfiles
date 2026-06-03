#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "install-symlinks remove_stale"
  install_symlinks="$SHELLSPEC_PROJECT_ROOT/install-symlinks"

  setup() {
    sandbox="$SHELLSPEC_TMPBASE/remove-stale"
    root="$sandbox/root"
    other_root="$sandbox/other-root"
    home="$sandbox/home"
    xdg="$home/.config"
    rm -rf "$sandbox"

    # Declared source for one desired link, under a fake dotfiles root.
    mkdir -p "$root/topic" "$other_root" "$home" "$xdg"
    printf 'kept\n' > "$root/topic/kept.conf"
    printf 'kept.conf:~/.kept\n' > "$root/topic/symlinks.conf"

    # Stale link directly under HOME: points into root but not declared.
    printf 'stale\n' > "$root/stale-source"
    ln -sfn "$root/stale-source" "$home/.stale"

    # Stale link nested under XDG: points into root but not declared.
    mkdir -p "$xdg/nested"
    ln -sfn "$root/stale-source" "$xdg/nested/stale"

    # Unrelated link under HOME: points outside root, must be left alone.
    printf 'unrelated\n' > "$other_root/unrelated-source"
    ln -sfn "$other_root/unrelated-source" "$home/.unrelated"
  }

  run_install() {
    HOME="$home" XDG_CONFIG_HOME="$xdg" "$install_symlinks" "$root"
  }

  BeforeEach 'setup'

  It "creates declared links, removes stale links into root, and preserves the rest"
    When call run_install
    The status should be success
    The output should include "removing stale symlink $home/.stale"
    The output should include "removing stale symlink $xdg/nested/stale"
    # Declared link created.
    The path "$home/.kept" should be symlink
    # Stale links into root removed.
    The path "$home/.stale" should not be exist
    The path "$xdg/nested/stale" should not be exist
    # Link pointing outside root left untouched.
    The path "$home/.unrelated" should be symlink
  End
End
