# Claude Code

Shell integration for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

## Worktree Aliases

Launch Claude in a [Worktrunk](https://worktrunk.dev) worktree. All variants pass `--name` to Claude, set from the branch name, and append a system prompt telling Claude it is in a dedicated worktree it can work in directly.

| Command | Branch | Permission mode |
|---------|--------|-----------------|
| `cw <branch>` | existing | default |
| `ccw <branch>` | create | default |
| `cwp <branch>` | create | plan |
| `cwa <branch>` | existing | auto |

Arguments after `--` are forwarded to `claude`:

```
ccw my-feature -- 'fix the bug'
ccw my-feature --base=@ -- 'stack on current branch'
cwa pr:123
```

`cwp` reads the pasteboard and passes it as Claude's initial prompt. Paste an issue URL or Linear prompt, then run `cwp <branch>`.

## Agent View

Dispatch and monitor background agents (`claude --bg` / `claude agents`).

`ca` opens the agent view. From there, logs, stop, and attach are a keypress away. Launch new agents with the `claude-launch` command below.

### Launcher

`claude-launch` walks you through a launch:

1. Pick a launch directory with fzf over zoxide's frecency list, with the directories of in-flight agents sorted to the top. Pass `--here` to skip the picker and use the current directory.
2. Choose permission mode and model. Each is optional. Skip to take Claude's default.
3. Write the task in an editor, pre-filled from the pasteboard when it looks like a task or URL.

The agent is dispatched detached and its id is logged. Monitoring and attach happen in the built-in view, so the launcher stops there.

### Tmux Popup and Status Chip

`prefix a` opens the agent view in a popup, near-fullscreen on a narrow client. A 󰚩 pill appears in the status bar while any background agent has finished or is blocked on input, and disappears at zero.

### Curation

`CLAUDE_AGENTS_ADD_DIR` (colon-separated) passes tool-access directories as repeated `--add-dir` to both the launcher's dispatch and the popup.

## Computer Use

Claude Code's built-in `computer-use` MCP drives the macOS GUI with screenshots and mouse/keyboard input. [Peekaboo](https://github.com/steipete/peekaboo) is the accessibility-tree fallback for cases where screenshot perception is brittle or too costly: `peekaboo see` snapshots the AX tree with element IDs, then `peekaboo click`/`type` target those IDs. Call it from any agent via the CLI.

Both need **Screen Recording** and **Accessibility** granted in System Settings > Privacy & Security. They fail silently without them.
