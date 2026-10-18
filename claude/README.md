# Claude Code

Shell integration for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

## Installation

`claude/install-native` runs Anthropic's native installer on macOS and Linux. It puts `claude` in `~/.local/bin` and keeps it current with its own background updater, so a release arrives the day it ships. The script does nothing once `~/.local/bin/claude` exists, so the nightly install downloads it only the first time.

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

herdr reaches the same view on `prefix+alt+a`, in a popup, through `herdr-claude-agents`. Its sidebar is no substitute: that lists the agent occupying each pane, and a background agent occupies none, so the view is the only place they appear.

### Launcher

`claude-launch` walks you through a launch:

1. Pick a launch directory with fzf over zoxide's frecency list, with the directories of in-flight agents sorted to the top. Pass `--here` to skip the picker and use the current directory.
2. Choose permission mode and model. Each is optional. Skip to take Claude's default.
3. Write the task in an editor, pre-filled from the pasteboard when it looks like a task or URL.

The agent is dispatched detached and its id is logged. Monitoring and attach happen in the built-in view, so the launcher stops there.

### Pruning

`claude-prune-agents` clears completed agents whose work has landed. An agent is
removable when every PR it produced has left the open state. A single open PR
keeps it, and an agent with no discoverable PR is reported but never removed.

PRs come from the branch the agent worked on and from the PR references in its
own summary. The stale set is offered as a preselected checklist, so enter
accepts the batch and esc removes nothing. `--dry-run` prints the decisions
without removing, `--force` skips the prompt.

### Curation

`CLAUDE_AGENTS_ADD_DIR` (colon-separated) passes tool-access directories as repeated `--add-dir` to both the launcher's dispatch and the popup.

## Plugins

The config repo's own plugins come from `~/.claude-repo`, the clone `claude/mise.macos.toml` declares, through a `directory`-source marketplace in its `settings.json`. Claude Code loads a relative-path plugin from a local marketplace in place, so an edit that `claude-sync` pulls takes effect at the next session start or `/reload-plugins`, with no cached copy to update. Claude Code installs no npm dependencies for an in-place plugin, so `claude-sync` runs `bun install --frozen-lockfile` at the clone's root after every sync. The plugins are workspaces of the root `package.json`, so that one install covers all of them. A failed install warns, the run carries on, and the to-do names it.

The third-party marketplaces still come from GitHub, and Claude Code copies their plugins into `~/.claude/plugins/cache`. The update and prune passes below exist for those copies.

`claude-sync --full` runs nightly. It syncs the Claude config repo, installs its dependencies, reinstalls the herdr and moshi integrations, uninstalls the plugins the synced `settings.json` no longer declares, refreshes every marketplace, then updates every plugin installed at user scope, disabled ones included. `claude plugin enable` does not update, so a plugin skipped while disabled would come back stale months later. Each install is skipped where its binary is absent. A relative-path plugin from a marketplace registered from a local path is skipped by the update pass, and installed only when it has no install record. An entry there that names a repo of its own is copied and updated like any other.

A hand run of `claude-sync`, say after pushing to the config repo, only installs the dependencies, refreshes every marketplace, and updates the plugins. The hook installs and both prunes run only with `--full`, which the launchd job passes. A failed marketplace refresh fails either run.

The herdr install writes `~/.claude/hooks/herdr-agent-state.sh`, which the config repo gitignores. It also appends a `SessionStart` entry to `settings.json`, which the sync discards: herdr cannot recognize the committed `$HOME` form of the same entry and only checks the script's version marker. What comes back is the file as it stood before the install, so an edit already in the tree survives. The restore runs whether or not the install finished, because an entry left behind stops the next night's run at the sync gate, before it reaches the step that would clear it. The moshi install's edits stay. A diff in `settings.json` is a moshi upgrade, and the run stops at that same gate until the diff is committed.

The herdr and moshi installs both write `~/.claude/settings.json` by replacing it, which breaks the symlink into the config repo. Every run relinks `~/.claude` with `install_claude_symlinks` from `claude/install.sh`, after the gate and after each install, and warns for each link it repaired. Before the gate, the sync copies a replaced `settings.json` into the config repo when its content differs, so a real change stops at the gate instead of being lost in the relink. A replacement that is not valid JSON is discarded.

Vibe Island's SSH remote deploy rewrites the hook commands in `settings.json` on the machine it deploys to. Each one then names `vibe-island-hook`, a binary only its remote agent installs. Its `hookAutoConfig_claude` preference covers local hooks only. No setting stops the remote write. When every hook command the committed file lacks names `vibe-island-hook` and nothing outside `.hooks` changed, the sync restores the committed file and posts a notification. Any other change is left for the gate.

A plugin no longer offered by its marketplace is left alone, with an info line in the log. Nothing can update it, so the fix is to uninstall it.

### Pruning

`settings.json` is the declaration, and `claude plugin install` writes the plugin's key into it. A user-scope payload with no key is one whose declaration was removed, by a commit that synced down or by hand, so `claude-sync` uninstalls it. Without that the removal never reaches the machine and the payload is refreshed nightly forever.

A key set to `false` still declares the plugin. That is a plugin installed and turned off, and its payload stays.

Dependencies are the exception a declaration cannot express. Claude Code installs a plugin named in another plugin's `dependencies` without writing a key for it, and marks its record in `installed_plugins.json` with `auto: true`. The uninstall pass skips those, and `claude plugin prune` then removes the ones no remaining plugin depends on. A dependency installed before Claude Code recorded the flag carries none, so it is uninstalled unless `settings.json` names it.

An unreadable `settings.json` fails the run rather than pruning against an empty declaration, which would take every plugin on the machine. Uninstalling touches only ids the file does not name, so the pass writes nothing back and cannot dirty the tracked config and stall the next night at the sync gate.

A plugin the marketplace dropped keeps its declaration, so the prune leaves it. Removing the payload while `settings.json` still names it would leave an entry pointing at nothing.

### Repairing a Stale Plugin

`claude plugin uninstall <id>` then `claude plugin install <id>`. Deleting the payload and running `claude plugin update` does not work on a plugin that declares a fixed `version`: it reports `already at the latest version` whether or not the payload is even there, so the delete stands and the plugin ends up uninstalled behind a successful-looking update.

Payload directories carry an `.in_use` directory holding one file per session PID. Check those with `kill -0` before removing anything by hand. Deleting a payload out from under a live session breaks its skill loads until restart.

## Computer Use

Claude Code's built-in `computer-use` MCP drives the macOS GUI with screenshots and mouse/keyboard input. [Peekaboo](https://github.com/steipete/peekaboo) is the accessibility-tree fallback for cases where screenshot perception is brittle or too costly: `peekaboo see` snapshots the AX tree with element IDs, then `peekaboo click`/`type` target those IDs. Call it from any agent via the CLI.

Both need **Screen Recording** and **Accessibility** granted in System Settings > Privacy & Security. They fail silently without them.
