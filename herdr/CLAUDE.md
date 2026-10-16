# herdr Configuration

This session runs inside the herdr server this directory configures. Change it without taking that server down.

## The Live Session

Never run `herdr server stop` or signal the server. It kills every pane, this session included.

`herdr server reload-config` reads the installed `~/.config/herdr/config.toml`, so a worktree edit is invisible to it until it merges and syncs. `HERDR_CONFIG_PATH` is read only at server start. Validate a worktree config with it instead:

```sh
HERDR_CONFIG_PATH="$PWD/herdr/config.toml" herdr config check
```

It rejects unknown keys, token names, types, and enum variants. It reports `config: ok` for a path that does not exist, so confirm the file exists first. A server started on an unparseable config runs stock defaults and logs one warning, so the change looks like it did nothing.

Repoint the `~/.config/herdr/config.toml` symlink at a worktree only when the user asks to see a change in their own session. Restore it before finishing.

## Preview Sessions

Do all testing and demos in a preview session. Use `bin/herdr-preview` rather than hand-rolling one, because it checks for the failures that otherwise render a plausible but wrong sidebar. Drive the preview with `export HERDR_SOCKET_PATH="$(herdr-preview socket)"`.

- Run `start` and `stop` with the Bash sandbox off. `read` and `socket` work sandboxed.
- Apply an edited config to a preview with `stop` and `start`. `reload-config` against a preview loads the user's installed config.
- Read the rendered sidebar as text with `herdr-preview read` (`--ansi` for token colors) before reaching for a screenshot. For a nested client, `pane read --source visible` works and `--source recent` does not.
- The client drops the sidebar below about 60 columns. The sidebar column is 25 wide, which is the width to judge truncation against.
- `pane layout` reports the outer pane, not the nested client's size. Read the negotiated size from the preview's `herdr-server.log`.
- A `tab_bar_right` command runs against the preview's socket, so `herdr-workspace-status` overwrites hand-reported tokens on any workspace with a checkout. For a scene of hand-reported tokens, use workspaces with no checkout path or remove the entry.
- Never move `XDG_CONFIG_HOME` to isolate a preview. `~/.config/herdr` holds the live server's sockets, so the client would drive the user's session.

### Hand-Launched Clients

- Unset `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_BIN_PATH`, and `HERDR_SOCKET_PATH`, and set `HERDR_CONFIG_PATH`. The client renders the sidebar from the config in its own environment.
- Name the worktree path in a `tab_bar_right` command under test. A bare name resolves against the server's `$PATH` and runs the installed copy.
- Run a client through a script file, not an inline `pane run` string. `colors/grc.zsh` aliases `env`, which sends the client's output into a pipe.
- Check `herdr pane process-info --pane <id>` before `pane run`. Against a pane holding a TUI, it types into the TUI and still reports success.

For a real screenshot, launch a separate Ghostty instance:

```sh
open -na Ghostty --args -e env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH HERDR_CONFIG_PATH="$PWD/herdr/config.toml" herdr --session preview
```

AppleScript cannot reach a second Ghostty instance, and its title is not unique. Find its window id by diffing the `screenshot-terminal` skill's `list-terminal-windows` before and after the launch. The sidebar is about the left 760 pixels of a default-size capture. Re-measure when the dimensions differ, and read the crop with the Read tool.

Tear a hand-started session down with:

```sh
herdr session stop preview
herdr session delete preview
pkill -f 'ghostty -e env .*herdr --session preview'
```

### Synthetic State

```sh
id=$(herdr workspace create --label failing-checks --cwd "$PWD" --no-focus | jq -r '.result.workspace.workspace_id')
glyph=$(python3 -c 'print(chr(0xF407))')
herdr workspace report-metadata "$id" --source demo --ttl-ms 3600000 --token "status_red=$glyph"
```

An agent row needs no agent. `pane report-agent` is allowed in a preview:

```sh
pane=$(herdr api snapshot | jq -r --arg id "$id" '.result.snapshot.panes[] | select(.workspace_id == $id) | .pane_id')
herdr pane report-agent "$pane" --source demo --agent claude --state blocked
herdr pane report-metadata "$pane" --source demo --ttl-ms 3600000 --token 'title=Review the green branch'
```

`workspace create --cwd` runs no repository detection, so the panel draws those workspaces flat. For the nested worktree layout, open each with `herdr worktree open --workspace <repo workspace> --path <worktree> --trust-repository`. The panel then draws worktrees under their repo row, in an order that differs from the snapshot array.

### Reviewing a Sidebar Change

Build each scene as a script that empties the preview and rebuilds it, since a restart discards synthetic state. Cover three scenes: one state per row, a realistic ordinary day, and the worst case with every glyph lit under a long label. The worst case decides whether a shape ships, because custom tokens right-align and truncate the label. Send each scene to the user as a crop or as `herdr-preview read` text. Put a proposed shape in as its own scene before coding it.

## Sidebar Tokens

herdr strips escape codes from token values. A new color is a new token name, both where it is reported and where `config.toml` styles it. The Claude status line in bendrucker/claude reports `$title` and `$ctx_*` on panes, which `config.toml` does not render. The agent row uses herdr's `terminal_title_stripped` instead. `$review` comes from the `review:human` skill's `attention.ts` in that repo.

## Tab and Workspace Numbers

To derive a chord digit, count a row's position in the snapshot array. `tab.number` is the creation ordinal and never moves. `workspace.number` renumbers on close, and herdr relabels default-named tabs to their live position, so `number` goes wrong after the first close.

## Scripts Under Live Edit

A syntax error or unbound variable at a line number past the file's end means the script was rewritten while bash was reading it. Do not debug the code. To run a script from a tree someone may be editing, copy it and run the copy. To edit a script that may be running, write a temporary file and rename it over the target.

## Tests

Stub `herdr`, `gh`, and `glab` on `PATH` in tests. A test that reaches the live server acts on the user's session.
