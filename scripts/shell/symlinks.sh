# shellcheck shell=sh
# The repo's symlink primitive: create idempotent links and prune stale ones.
# POSIX sh so both the sh install-symlinks and the bash claude/install.sh can
# source it. Sourcing has no side effects.

# symlink_create <src> <dst>
#   Create dst as a symlink to src, making parent directories as needed.
#   Silent and idempotent. Source-existence validation belongs in the caller.
#   A real directory at dst is fatal: `ln -sfn` would put the link inside it
#   rather than replace it, and the caller's contents are worth a look before
#   anything removes them.
symlink_create() {
  if [ -d "$2" ] && [ ! -L "$2" ]; then
    echo "symlink_create: $2 is a directory; move its contents into $1 and remove it" >&2
    return 1
  fi
  mkdir -p "$(dirname "$2")"
  ln -sfn "$1" "$2"
}

# symlink_prune <root> <desired>
#   Read candidate link paths from stdin (one per line) and remove those that
#   are symlinks pointing under <root> but absent from the newline-delimited
#   <desired> list. Echoes each removal.
symlink_prune() {
  prune_root="$1"
  prune_desired="$2"
  while IFS= read -r link; do
    [ -L "$link" ] || continue
    target="$(readlink "$link" 2>/dev/null)" || continue
    case "$target" in
      "$prune_root"/*) ;;
      *) continue ;;
    esac
    if ! printf '%s\n' "$prune_desired" | grep -qFx "$link"; then
      echo "install-symlinks: removing stale symlink $link -> $target"
      rm "$link"
    fi
  done
}
