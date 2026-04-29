# tmux/: working with tmux configuration autonomously

You handle reloads. Don't ask the user to run `tmux source-file`. Do it.

## Reloading

`tmux.conf` sources modules via `~/.config/tmux/<topic>/<topic>.conf` (TPM's plugin discovery only parses `source-file` lines without `-F`, so worktree-relative paths there break plugin install). For worktree edits, source the specific module file directly:

```sh
tmux source-file "$(git rev-parse --show-toplevel)/tmux/<topic>/<topic>.conf"
```

For `tmux.conf` itself or for a clean reload of everything, you must sync the worktree to `~/.dotfiles` first (or hardlink the changed file in). `prefix r` reloads the installed copy at `~/.config/tmux/tmux.conf` and misses unsynced worktree edits.

Don't `tmux kill-server` or restart tmux. That nukes the user's panes.

## Removed bindings

`tmux source-file` only adds bindings, never removes them. When you delete a custom binding from a topic conf, also append `unbind <key>` to `tmux/core/unbinds.conf`. That file is sourced after `core.conf` on every reload. Old entries get trimmed periodically once any tmux server that had them is gone.

Permanent unbinds of tmux defaults (e.g. `unbind C-b` to free the prefix) stay with their topic, not in `unbinds.conf`.

## Plugin variable changes

Plugins (`set -g @<plugin>-<var>`) read their variables at init only. Sourcing `tmux.conf` updates the variable but doesn't rebind anything. Re-run the plugin's loader directly. The entrypoint filename varies by plugin (`tmux-fzf/tmux-fzf.tmux`, `tmux-fuzzback/fuzzback.tmux`), so list it first:

```sh
ls $TMUX_PLUGIN_MANAGER_PATH/<plugin>/*.tmux
bash $TMUX_PLUGIN_MANAGER_PATH/<plugin>/<entrypoint>.tmux
```

`bash` works for plugins whose entrypoint is just `tmux bind-key` calls (most). `tmux run-shell` would also work but isn't auto-allowed (it executes arbitrary scripts).

For new plugins added via `set -g @plugin '...'`, source the conf first, then run TPM's installer:

```sh
bash $TMUX_PLUGIN_MANAGER_PATH/tpm/bindings/install_plugins
```

## Verification

Always confirm the change registered before handing off:

- Binding: `tmux list-keys -T prefix <key>` (tmux looks up the key directly).
- Plugin var: `tmux show-options -gv "@<plugin>-<var>"`.
- If a reload looks silent, check `tmux show-messages` and `~/.cache/tmux/tmux-server-*.log`.

## Use the `tmux:tmux` skill

Load `tmux:tmux` (auto-allowed) when you need pane/window/session awareness.

## What the user drives

You handle reloads. The user still presses the keys to exercise new bindings. Muscle memory only sticks if they do it. After reloading, tell them what to press and what to expect. Don't `send-keys` to their working pane to "demonstrate". That defeats the point.
