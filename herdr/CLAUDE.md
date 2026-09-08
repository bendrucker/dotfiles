# herdr/: Working With herdr Configuration Autonomously

This session runs in a herdr pane. Everything below is about changing herdr without taking that session down. Load the `herdr:herdr` skill when a task needs pane, tab, or workspace awareness.

## The Live Session

`herdr server reload-config` re-reads `~/.config/herdr/config.toml`, which links to `~/.dotfiles`, so a worktree edit is invisible to it until the branch merges and syncs. `HERDR_CONFIG_PATH` is read once at server start and never on reload, so it cannot point the running server at a worktree either. Validate a worktree file with it instead:

```sh
HERDR_CONFIG_PATH="$PWD/herdr/config.toml" herdr config check
```

A file the server cannot parse is not rejected. `reload-config` keeps the old config and reports the problem as `diagnostics` in its response, and `reload.sh` is what surfaces that.

Never `herdr server stop`. It takes down every pane the session owns, this one included.

Previewing a worktree config in the user's real session means repointing the `~/.config/herdr/config.toml` symlink at the worktree, reloading, and restoring it afterwards. Do that only when the user asks to see a change in their own session, and restore the link before finishing. A shape the real session cannot be put into, such as a workspace whose checks are failing or an agent parked on a permission dialog, goes in a preview session.

## A Preview Session

A named session is a second server with its own panes, workspaces, sockets, and saved state, started on whatever config the launching command names. It is the place for synthetic state, since nothing reported into it reaches the user's session. Use them for all testing and demos to avoid mutating the user's live session.

Launch it in its own Ghostty window:

```sh
open -na Ghostty --args -e env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH HERDR_CONFIG_PATH="$PWD/herdr/config.toml" herdr --session preview
```

The `-u` flags matter. The new window inherits this pane's environment, and a `herdr` that sees `HERDR_ENV` refuses to start inside another herdr. `open -na` starts a second Ghostty instance, so the window is not reachable through AppleScript sent to the first one. Record the window id by diffing `list-terminal-windows` from the `screenshot-terminal` skill before and after the launch. The window's title is `Studio.local: ~`, which is not unique enough to match on.

Every command against the preview goes through its socket:

```sh
export HERDR_SOCKET_PATH=~/.config/herdr/sessions/preview/herdr.sock
herdr session list --json
```

The user-level sandbox allows only the default session's socket. The project settings add `~/.config/herdr/sessions`, so these run sandboxed. A refused connection to this socket has some other cause.

After editing the worktree config, `herdr server reload-config` against that socket re-reads it, since the server took the path from `HERDR_CONFIG_PATH` at start.

### Synthetic State

Workspaces and their sidebar tokens:

```sh
id=$(herdr workspace create --label failing-checks --cwd "$PWD" --no-focus | jq -r '.result.workspace.workspace_id')
glyph=$(python3 -c 'print(chr(0xF407))')
herdr workspace report-metadata "$id" --source demo --ttl-ms 3600000 --token "status_red=$glyph"
```

An agent row needs no agent. `pane report-agent` overrides detection for a pane, which the herdr skill forbids on the real session and which is exactly the point here:

```sh
pane=$(herdr api snapshot | jq -r --arg id "$id" '.result.snapshot.panes[] | select(.workspace_id == $id) | .pane_id')
herdr pane report-agent "$pane" --source demo --agent claude --state blocked
herdr pane report-metadata "$pane" --source demo --ttl-ms 3600000 --token 'title=Review the green branch'
```

A review of a sidebar change is a set of named scenes, each one a script that empties the preview and rebuilds it: one state per row for the catalog, a realistic mix of workspaces and agents for the ordinary day, and the worst case with every glyph lit under a long label. The worst case decides whether the shape ships. herdr right-aligns custom tokens and truncates the label to fit them, so clutter shows up as the workspace name disappearing. Capture each scene, send the crops, and put a proposed shape in as a scene of its own before coding it, since the user is the acceptance tester and a synthetic row costs nothing to reject.

Nerd Font glyphs pasted into a tool call can arrive as an empty string. Build them from codepoints (`python3 -c 'print(chr(0xF407))'`) and check what the snapshot holds.

`tab_bar_right` command entries run in the server with no `HERDR_SOCKET_PATH`, so the preview's copy of `herdr-workspace-status` reports into the default session and never overwrites synthetic tokens. To fill the preview from real repositories instead, run the script yourself with the preview socket exported.

### Capture

Capture the preview window with the `screenshot-terminal` skill's `capture-window` and `crop-png`, both with the sandbox off. The sidebar was the left 760 pixels of a capture at the default window size, so re-measure when the image dimensions differ. Read the crop with the Read tool rather than describing it from the token values.

### Teardown

```sh
herdr session stop preview
herdr session delete preview
pkill -f 'ghostty -e env .*herdr --session preview'
```

`stop` ends the server and its panes. `delete` removes the saved shape under `~/.config/herdr/sessions/preview`, so the next `--session preview` starts empty. The `pkill` closes the second Ghostty instance, which stays open on the exited client otherwise. Leave the default session's Ghostty alone.

## Sidebar Tokens

`bin/herdr-workspace-status` reports the `$status_*` and `$branch` workspace tokens, which the spaces rows render. The Claude status line in bendrucker/claude also reports `$title` and `$ctx_*` on panes, and `config.toml` renders neither. The Claude agent row takes herdr's built-in `terminal_title_stripped` instead, which holds the same session name with the leading state glyph removed. herdr strips escape codes from token values, so a color is a token name styled in `config.toml`, and a new color is a new name in both places.

## Tests

A script in `bin/` gets a `bun test` file beside it, `bin/<script>.test.ts`, checking that it is executable, passes `shellcheck`, resolves on `PATH` through `path.zsh`, and is bound in `config.toml` the way that binding needs to read. Most are bound by their bare name. `herdr-flock` is bound by a path, because the server holds the environment it started with, and a bare name would resolve against a `$PATH` that can predate `herdr/path.zsh`. Stub `herdr`, `gh`, and `glab` on `PATH` rather than talking to the live server. `#harness` holds the sandbox, the stub writer, and `resolveOnPath`, which is what does the `path.zsh` lookup.
