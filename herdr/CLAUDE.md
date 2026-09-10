# herdr/: Working With herdr Configuration Autonomously

This session runs in a herdr pane. Everything below is about changing herdr without taking that session down. Load the `herdr:herdr` skill when a task needs pane, tab, or workspace awareness.

## The Live Session

`herdr server reload-config` re-reads `~/.config/herdr/config.toml`, which links to `~/.dotfiles`, so a worktree edit is invisible to it until the branch merges and syncs. `HERDR_CONFIG_PATH` is read once at server start and never on reload, so it cannot point the running server at a worktree either. Validate a worktree file with it instead:

```sh
HERDR_CONFIG_PATH="$PWD/herdr/config.toml" herdr config check
```

That is a real validator, not a syntax check. It resolves herdr's own token names, so a sidebar row naming a token that does not exist comes back as `unknown sidebar token`, and so do an unknown key, a wrong type, and an unknown enum variant. `herdr.integration.test.ts` runs it over the tracked config.

Its one blind spot is a path that does not exist, which it reports as `config: ok` with exit 0. A typo in `HERDR_CONFIG_PATH` therefore buys a green light. Check the file is there first.

A file the server cannot parse is not rejected either. `reload-config` keeps the old config and reports the problem as `diagnostics` in its response, and `reload.sh` is what surfaces that. A server *starting* on an unparseable config is worse: it warns once into its own log and runs on stock defaults, so the sidebar renders as though the change did nothing.

Never `herdr server stop`. It takes down every pane the session owns, this one included.

Previewing a worktree config in the user's real session means repointing the `~/.config/herdr/config.toml` symlink at the worktree, reloading, and restoring it afterwards. Do that only when the user asks to see a change in their own session, and restore the link before finishing. A shape the real session cannot be put into, such as a workspace whose checks are failing or an agent parked on a permission dialog, goes in a preview session.

## A Preview Session

A named session is a second server with its own panes, workspaces, sockets, and saved state, running whatever config file it was started on. It is the place for synthetic state, since nothing reported into it reaches the user's session. Use one for all testing and demos.

`bin/herdr-preview` runs the whole loop, and the reason to use it rather than the commands under it is that most of the ways this goes wrong are silent:

```sh
herdr-preview start                     # validate, launch, wait for live rows
herdr-preview read | cut -c1-90 | nl -ba
herdr-preview read --ansi               # token colors as truecolor escapes
export HERDR_SOCKET_PATH="$(herdr-preview socket)"
herdr-preview stop
```

`pane read --lines` returns the *bottom* n rows, and the spaces panel is at the top. A count short of the client's height comes back with no sidebar in it, which reads as a config that did not apply. The count is a ceiling, so over-reading costs nothing and `herdr-preview read` asks for more rows than a terminal has. Pass `--lines` only to read less on purpose.

`pane layout` cannot tell you the real height. Its rect describes the outer pane, not the screen the nested client negotiated, and the two disagree: a client logging `client connected cols=170 rows=62` sat in a rect of 44 by 36. The negotiated size appears only in the preview's own `herdr-server.log`.

`start` and `stop` both need the Bash sandbox off. The server sets its own priority, which the sandbox denies, and it exits before creating a socket. `stop` deletes the saved session, which writes under `~/.config/herdr`, also denied. `read` and `socket` run sandboxed, because the project settings allow the session sockets, so a refused connection to a preview socket has some other cause.

An edited config reaches a preview only through `stop` and `start`. `herdr server reload-config` re-reads the default path rather than the one `HERDR_CONFIG_PATH` named at start, so against a preview it quietly loads the user's installed config. The synthetic state goes with the restart, which is why a scene is a script rather than a sequence of commands.

A `start` that fails after its server came up tears that server down, deletes the saved session, and closes the tab it created, so the next `start` is not refused by a preview nobody can see. A pane passed with `--pane` is the caller's and stays open.

### Why It Reads As Text

The client runs inside a pane of the calling session, so `herdr pane read` returns herdr's own chrome: sidebar rows, dividers, truncation, and under `--format ansi` the exact hex a token is styled with. That is the channel to reach for first. It works with the screen locked and with `screencapture` broken, which is most of when a sidebar question comes up. Screenshots are the confirmation step, not the only one.

The alt-screen caveat in the herdr skill applies to scrollback, not to the visible screen. `--source visible` sees a nested client. `--source recent` does not.

### The Two Environment Variables

`HERDR_CONFIG_PATH` names the config file and is read once at server start. `HERDR_SESSION` names the session and roots every runtime path at `~/.config/herdr/sessions/<name>/`.

Between them there is no reason to touch `XDG_CONFIG_HOME`. Moving that instead means mirroring the config directory, because `~/.config/herdr` holds runtime state next to the config: `herdr.sock`, `herdr-client.sock`, `session.json`, `session-history.json`, `sessions/`, and both logs. A wholesale symlink therefore points the preview client at the live server's socket and drives the user's real session. Moving only the config file leaves `plugins/` and `agent-detection/` resolving out of the real directory, which is what a faithful preview wants anyway.

It also keeps the socket path short. macOS caps a unix socket path near 104 bytes, and a config root under a scratch directory blows through that on its own. The server reports the overflow as a startup timeout naming a socket it never tried to create, so it reads as a hang rather than a length problem.

### What Lies

Four failures here produce a plausible-looking preview rather than an error. `herdr-preview` checks all four. A hand-rolled loop has to do the same.

- A config the server cannot parse does not stop it. It warns into its own log and runs on stock defaults, so the change reads as having done nothing.
- `herdr config check` reports `config: ok` for a file that does not exist.
- A bare `tab_bar_right` command resolves against the server's `$PATH`, which is the installed `~/.dotfiles` copy rather than the worktree. A config whose tokens come from a script under test renders bare rows, which reads as a config bug. `herdr-preview` repoints any command naming a repo script at the worktree and says which.
- A client that has attached can still be painting the workspace list it started with. Wait for a row it could only draw from live state rather than for the process. `herdr-preview` creates a `rdy<pid>` workspace after the client attaches and waits for that label. The pid keeps a crashed run's saved workspace from matching, and the label stays short because the sidebar truncates to its column width: waiting on `preview-ready-80945` never fires, since the screen holds `preview-ready…`.

### Two Ways To Launch A Client

`herdr pane run` hands its string to the pane's *interactive* shell, which expands aliases. `colors/grc.zsh` aliases `env`, so an inline `env -u HERDR_ENV … herdr` becomes `grc --colour=auto env …` and the client renders into a pipe instead of the tty. `pane read` then shows the shell prompt and the client looks like it failed to start. Run a file instead.

Against a pane already holding a TUI, `pane run` types into that TUI and reports success. Check `herdr pane process-info --pane <id>` before running anything in a pane.

Unsetting `HERDR_ENV` is what lets a client start nested. `experimental.allow_nested` is not needed. Unset `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_BIN_PATH`, and above all `HERDR_SOCKET_PATH`, which would otherwise point the preview client at the live server.

A separate Ghostty window is the alternative when a real screenshot is wanted:

```sh
open -na Ghostty --args -e env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH HERDR_CONFIG_PATH="$PWD/herdr/config.toml" herdr --session preview
```

`open -na` starts a second Ghostty instance, so the window is not reachable through AppleScript sent to the first one. Record the window id by diffing `list-terminal-windows` from the `screenshot-terminal` skill before and after the launch. The window's title is `Studio.local: ~`, which is not unique enough to match on.

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

A review of a sidebar change is a set of named scenes, each one a script that empties the preview and rebuilds it: one state per row for the catalog, a realistic mix of workspaces and agents for the ordinary day, and the worst case with every glyph lit under a long label. The worst case decides whether the shape ships. herdr right-aligns custom tokens and truncates the label to fit them, so clutter shows up as the workspace name disappearing. Read each scene back and send it, as a crop where capture works and as `herdr-preview read` text where it does not. Put a proposed shape in as a scene of its own before coding it, since the user is the acceptance tester and a synthetic row costs nothing to reject.

Nerd Font glyphs pasted into a tool call can arrive as an empty string. Build them from codepoints (`python3 -c 'print(chr(0xF407))'`) and check what the snapshot holds.

A `tab_bar_right` command entry runs in the server *with* the session's context: `HERDR_SOCKET_PATH` and `HERDR_SESSION` pointing at that session, plus `HERDR_CONFIG_PATH` and `HERDR_ACTIVE_WORKSPACE_ID`, `HERDR_ACTIVE_TAB_ID`, `HERDR_ACTIVE_PANE_ID`, and `HERDR_ACTIVE_PANE_CWD`. So the preview's own copy of `herdr-workspace-status` reports into the preview, on the interval in the config, and will overwrite synthetic tokens on any workspace it can resolve a checkout for. That is what makes a metadata-reporting script testable in a preview at all, and it is also why a scene of hand-reported tokens needs either workspaces with no checkout path or a config with the entry removed.

### Capture

Run the `screenshot-terminal` skill's `preflight` first. It takes a real capture rather than inferring one is possible, and it reports `capture-failed` with `screen_recording: false` when the calling terminal app has lost its Screen Recording grant, which a major macOS upgrade resets. Nothing from the shell restores it. Fall back to `herdr-preview read`.

When capture does work, use `capture-window` and `crop-png`, both with the sandbox off. The sidebar was the left 760 pixels of a capture at the default window size, so re-measure when the image dimensions differ. Read the crop with the Read tool rather than describing it from the token values.

### Teardown

`herdr-preview stop` closes the client's tab, stops the server, and deletes the saved shape so the next start is empty rather than a replay. For a session started by hand:

```sh
herdr session stop preview
herdr session delete preview
pkill -f 'ghostty -e env .*herdr --session preview'
```

The `pkill` closes the second Ghostty instance, which stays open on the exited client otherwise. Leave the default session's Ghostty alone.

## Editing A Script Another Agent Is Running

bash reads a script incrementally by byte offset rather than loading it whole. A file that grows while a shell is executing it resumes at a shifted boundary and parses a fragment as a command, so the error names a line that did not exist when the run started. A sibling agent running `herdr-preview` out of this worktree hit exactly that, and reported a syntax error at a line number sixty lines past the end of the file it had launched.

Write an edit to a temporary path and rename it over the target. The rename is atomic, so a running shell keeps its descriptor on the old inode and reads a consistent file to the end. Truncating in place, which is what an ordinary write does, is the version that corrupts a live reader. This is worth knowing whenever a script here is something another agent runs.

## Tab And Workspace Numbers

`tab.number` in the snapshot is the ordinal a tab was created at and never moves. `workspace.number` is a live position and renumbers when a workspace closes. herdr also renames a default-named tab down to its live position, so closing the first of four tabs leaves labels `review`, `2`, `3` sitting against numbers 2, 3, 4.

Anything deriving a chord digit has to count a row's place in the snapshot array. Reading `number` gives the wrong tab for the rest of that workspace's life, and it is quiet, because it is right until the first close.

## Sidebar Tokens

`bin/herdr-workspace-status` reports the `$status_*` and `$branch` workspace tokens. The Claude status line in bendrucker/claude reports `$title` and `$ctx_*` on panes. herdr strips escape codes from token values, so a color is a token name styled in `config.toml`, and a new color is a new name in both places.

## Tests

A script in `bin/` gets a `bun test` file beside it, `bin/<script>.test.ts`. `launcherContract` from `#harness/launchers` covers the three every one of them shares: executable, passes `shellcheck`, and resolves on `PATH` through `path.zsh`. A script bound in `config.toml` also asserts that the binding reads the way that binding needs to. Most are bound by their bare name. `herdr-flock` is bound by a path, because the server holds the environment it started with, and a bare name would resolve against a `$PATH` that can predate `herdr/path.zsh`. Stub `herdr`, `gh`, and `glab` on `PATH` rather than talking to the live server. `#harness` holds the sandbox, the stub writer, and `resolveOnPath`, which is what does the `path.zsh` lookup.
