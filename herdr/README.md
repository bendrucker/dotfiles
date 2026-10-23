# herdr

[herdr](https://herdr.dev) is the multiplexer this machine runs its panes in,
and the thing that knows which coding agent occupies which one.

`config.toml` is the whole configuration and carries its own reasoning inline,
including every keybinding and why it took the key it did. `install.sh`
installs and updates herdr and converges plugins onto `plugins.list`, and `reload.sh` hands a changed
`config.toml` to the running server without restarting it, so the nightly
upgrade never takes live panes down.

## Server

herdr installs from its own installer into `~/.local/bin`, not from Homebrew,
because only a binary `herdr update` manages can live-hand-off a running server.
`install.sh` runs `herdr update --handoff`, which moves every pane onto the new
release without ending the processes in them. herdr refuses to update from
inside one of its own panes, so a hand run from herdr leaves the update to the
nightly upgrade. To update by hand, from a terminal outside herdr:

```sh
herdr update --handoff
```

A failed handoff leaves the old server running with its panes.

No launchd agent runs the server. The first `herdr` client spawns it, so on
macOS the terminal that client runs in becomes its TCC identity, and the
server and its panes get Ghostty's access to Desktop, Downloads, and Apple
Events. A handoff passes that identity on to the replacement server. A server
launchd starts is its own identity, and macOS doesn't extend those grants to a
bare binary.

### Leaving launchd

A machine that ran the old launchd agent keeps its server under launchd until
it restarts, and `install.sh` skips the update until then. The migration that
removes the agent and the Homebrew formula waits for the same thing. When the
panes can stop, from a terminal outside herdr:

```sh
launchctl bootout "gui/$UID/me.bendrucker.herdr"
herdr
```

`[session] resume_agents_on_restore` brings the agents back, and the next
install finishes the cleanup.

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
