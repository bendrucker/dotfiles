# herdr

[herdr](https://herdr.dev) is the multiplexer this machine runs its panes in,
and the thing that knows which coding agent occupies which one.

`config.toml` is the whole configuration and carries its own reasoning inline,
including every keybinding and why it took the key it did. `install.sh`
converges plugins onto `plugins.list`, and `reload.sh` hands a changed
`config.toml` to the running server without restarting it, so the nightly
upgrade never takes live panes down.

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

## Agent detection

herdr classifies a pane's agent by matching its screen against a detection
manifest. `agent-detection/` holds the rules herdr's own manifests are missing,
and `bin/herdr-agent-detection` composes them onto whatever herdr last fetched.
`spec/agent_detection_spec.sh` scores the recorded screens in that directory, so
a rule that stops matching fails in CI rather than in the sidebar.
