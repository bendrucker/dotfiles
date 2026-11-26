# shellcheck shell=sh
# Claude Code's processes inherit install directories `mise activate` resolved
# for the launching shell's cwd, so swap them for the shims, which resolve each
# project's pin. The loop avoids word splitting, which zsh skips, because
# CLAUDE_ENV_FILE runs this in the Bash tool's zsh after the snapshot.
__shims_data="${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}"
__shims_path="$__shims_data/shims"
__shims_rest="$PATH:"
while [ -n "$__shims_rest" ]; do
  __shims_dir="${__shims_rest%%:*}"
  __shims_rest="${__shims_rest#*:}"
  case $__shims_dir in
    "" | "$__shims_data/installs/"* | "$__shims_data/shims") ;;
    *) __shims_path="$__shims_path:$__shims_dir" ;;
  esac
done
export PATH="$__shims_path"
unset __shims_data __shims_path __shims_rest __shims_dir
