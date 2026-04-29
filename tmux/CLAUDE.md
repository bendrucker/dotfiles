# tmux/: working with tmux configuration autonomously

You handle reloads. Don't ask the user to run `tmux source-file`. Do it.

## Reloading

`tmux.conf` sources its modules with `-F "#{d:current_file}/<topic>/<topic>.conf"`, so they load from the same directory the `tmux.conf` itself was sourced from. To reload a worktree edit:

```sh
tmux source-file "$(git rev-parse --show-toplevel)/tmux/tmux.conf"
```

Don't use `~/.config/tmux/tmux.conf` or `prefix r`. Both follow the symlink to `~/.dotfiles` and miss your changes.

Don't `tmux kill-server` or restart tmux. That nukes the user's panes.

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

## Removing a binding

Sourcing won't unbind anything the conf no longer mentions. Use `tmux unbind -T <table> <key>` (defaults to `prefix` if `-T` is omitted).

## Verification

Always confirm the change registered before handing off:

- Binding: `tmux list-keys -T prefix <key>` (tmux looks up the key directly).
- Plugin var: `tmux show-options -gv "@<plugin>-<var>"`.
- If a reload looks silent, check `tmux show-messages` and `~/.cache/tmux/tmux-server-*.log`.

## Use the `tmux:tmux` skill

Load `tmux:tmux` (auto-allowed) when you need pane/window/session awareness.

## What the user drives

You handle reloads. The user still presses the keys to exercise new bindings. Muscle memory only sticks if they do it. After reloading, tell them what to press and what to expect. Don't `send-keys` to their working pane to "demonstrate". That defeats the point.
