#!/usr/bin/env zsh

if command -v mise >/dev/null 2>&1; then
  if [[ -n $CLAUDECODE ]]; then
    # Claude Code snapshots this shell's PATH once and replays it in every Bash
    # call, where no prompt hook runs to follow a cd. Install directories
    # computed for one cwd, inherited or activated here, would then shadow the
    # version another project pins, so resolve every tool through the shims.
    # claude/shell-prefix does the same for hooks and MCP servers.
    path=(${path:#${MISE_DATA_DIR:-$XDG_DATA_HOME/mise}/installs/*})
    path=("${MISE_DATA_DIR:-$XDG_DATA_HOME/mise}/shims" $path)
  else
    eval "$(mise activate zsh)"
  fi
fi
