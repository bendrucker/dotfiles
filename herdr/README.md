# herdr

[herdr](https://herdr.dev) is the multiplexer this machine runs its panes in,
and the thing that knows which coding agent occupies which one.

`config.toml` is the whole configuration and carries its own reasoning inline,
including every keybinding and why it took the key it did. `install.sh`
converges plugins onto `plugins.list`, and `reload.sh` hands a changed
`config.toml` to the running server without restarting it, so the nightly
upgrade never takes live panes down.

## Server

On macOS, `me.bendrucker.herdr.plist` runs `herdr server` as a launchd agent, so
it starts at login and restarts if it dies. A client attaches to whatever server
answers on the socket and spawns one only when none does. Without the agent, the
first client to start spawns the server, and that client's app becomes its TCC
identity, which decides whether panes may send Apple Events to apps like Things.

`install.sh` never loads or reloads the agent while a server is running. A
reload ends every pane, and a second server exits against the first one's
socket and respawns until it stops. The installer writes the plist and warns
instead, and the change takes effect at next login. To cut over by hand, from a
terminal outside herdr:

```sh
launchctl bootout "gui/$UID/me.bendrucker.herdr"
herdr server stop
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/me.bendrucker.herdr.plist
```

`bootout` stops a server launchd already runs, where `KeepAlive` would restart
one stopped any other way, and `herdr server stop` stops one it does not. Each
errors harmlessly when there is nothing for it to stop. The server logs to
`herdr-server.log` as before, and its stderr lands in
`~/Library/Logs/me.bendrucker.herdr.log`.

## Session persistence

`[session] resume_agents_on_restore` brings agents back after a server restart.
herdr learns which session to resume from the integration hook the claude repo
installs at `user/hooks/herdr-agent-state.sh`, which reports the session ref as
the agent runs.

Restarting the server is what a config or plugin change costs, so this is the
setting that decides whether a restart resumes the work or hands back a row of
empty panes. `[experimental] pane_history` covers the other half, preserving
each pane's screen history across that restart.

## Selection and copy

Ghostty draws a selection by inverting rather than tinting, so it reads the same
whether herdr or Ghostty is intercepting the mouse. Holding Option while
dragging bypasses herdr and gives the native terminal selection, which is what
to reach for when a selection would span panes. `[ui] copy_on_select` takes
whatever is selected straight to the clipboard.

`prefix+y` copies a pane's whole scrollback through `bin/herdr-grab-scrollback`,
for the build log or test run that has already scrolled past what a selection
can reach. `prefix+e` opens the same buffer in an editor instead, which is where
to go when the point is to read it rather than move it.

`completion.zsh` binds Ctrl-N to a picker over the words the pane has already
printed, so a path, branch, or container id that is already on screen gets
completed instead of retyped. It reads the same `recent-unwrapped` source, which
rejoins soft wraps, so a path the pane broke across rows comes back as one word.
The pick is inserted as a quoted shell word, since pane output is arbitrary text
and a word carrying `*` or `$(` would otherwise reach the parser as syntax.

herdr exposes no word-separator setting, so a double-click takes a word by its
own rules and a path or a flag comes back in pieces
([#713](https://github.com/bendrucker/dotfiles/issues/713)).

## Cleanup board

`prefix+alt+f` opens the board from the local plugin in `cleanup/`, an overlay
listing each worktree workspace that needs you or is ready to finish. A row
leads with the next step, then its pull request and the reason: `go` to an agent
that is blocked, done, failing CI, or ready to merge, `wake` an idle agent whose
pull request moved after it stopped, or `prune` a merged or closed one.
Everything else is counted in the header and hidden.

| Key     | Action                                                                |
| ------- | --------------------------------------------------------------------- |
| `enter` | Focus the workspace's agent pane and close the board                  |
| `p`     | Close the workspace, move the checkout to the Trash, then `wt remove` |
| `x`     | Close the pull request or merge request, then prune                   |
| `w`     | Edit and send a `[herdr-cleanup]` prompt to the agent                 |
| `r`     | Re-query the forge for every workspace and reload                     |
| `m`     | Show or hide rows from the `work` machine                             |

Prune asks first when the workspace has a live agent, uncommitted or unpushed
work, or ignored files, and lists up to ten of those files. `wt remove` deletes
the branch only when it was merged, leaving the rest for `wt-prune`.

The board reads pull request state from
`$XDG_STATE_HOME/dotfiles/herdr-pr-state/<workspace>.json`, which
`bin/herdr-workspace-status` writes each time the forge answers. The header
shows the oldest of those as `forge 5m ago`, so a forge that has stopped
answering shows up as an age that keeps growing. Rows from `work` come
over `ssh work`, which needs this branch synced there, and read as
`work unreachable` when the host does not answer in ten seconds.
