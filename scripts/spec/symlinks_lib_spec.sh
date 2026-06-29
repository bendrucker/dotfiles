#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "symlinks.sh"
  setup() {
    # shellcheck source=/dev/null
    source "$SHELLSPEC_PROJECT_ROOT/lib/symlinks.sh"
    sandbox="$SHELLSPEC_TMPBASE/symlinks-lib"
    rm -rf "$sandbox"
    mkdir -p "$sandbox"
  }
  BeforeEach 'setup'

  Describe "symlink_create"
    It "creates missing parent directories and an idempotent link"
      src="$sandbox/source"
      dst="$sandbox/nested/deep/link"
      printf 'content\n' > "$src"

      When call symlink_create "$src" "$dst"
      The status should be success
      The path "$dst" should be symlink
      The contents of file "$dst" should equal "content"

      # A second call must succeed without error and leave the same link.
      symlink_create "$src" "$dst"
      The path "$dst" should be symlink
    End
  End

  Describe "symlink_prune"
    setup_prune() {
      root="$sandbox/root"
      other="$sandbox/other"
      home="$sandbox/home"
      mkdir -p "$root" "$other" "$home"
      printf 'x\n' > "$root/declared-source"
      printf 'x\n' > "$root/stale-source"
      printf 'x\n' > "$other/outside-source"

      ln -sfn "$root/declared-source" "$home/declared"
      ln -sfn "$root/stale-source" "$home/stale"
      ln -sfn "$other/outside-source" "$home/outside"
    }
    BeforeEach 'setup_prune'

    run_prune() {
      printf '%s\n' "$home/declared" "$home/stale" "$home/outside" \
        | symlink_prune "$root" "$home/declared"
    }

    It "removes an undeclared link into root, keeps declared and outside links"
      When call run_prune
      The status should be success
      The output should include "removing stale symlink $home/stale"
      The path "$home/declared" should be symlink
      The path "$home/stale" should not be exist
      The path "$home/outside" should be symlink
    End
  End
End
