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

`claude-sync` runs nightly. It syncs the Claude config repo, reinstalls the herdr and moshi integrations, uninstalls the plugins the synced `settings.json` no longer declares, refreshes every marketplace, then updates every plugin installed at user scope, disabled ones included. `claude plugin enable` does not update, so a plugin skipped while disabled would come back stale months later. Each install is skipped where its binary is absent.

The herdr install writes `~/.claude/hooks/herdr-agent-state.sh`, which the config repo gitignores. It also appends a `SessionStart` entry to `settings.json`, which the sync discards: herdr cannot recognize the committed `$HOME` form of the same entry and only checks the script's version marker. What comes back is the file as it stood before the install, so an edit already in the tree survives. The restore runs whether or not the install finished, because an entry left behind stops the next night's run at the sync gate, before it reaches the step that would clear it. The moshi install's edits stay. A diff in `settings.json` is a moshi upgrade, and the run stops at that same gate until the diff is committed.

A plugin no longer offered by its marketplace is left alone. Nothing can update it, so the fix is to uninstall it, and the audit says so.

### Pruning

`settings.json` is the declaration, and `claude plugin install` writes the plugin's key into it. A user-scope payload with no key is one whose declaration was removed, by a commit that synced down or by hand, so `claude-sync` uninstalls it. Without that the removal never reaches the machine and the payload is refreshed nightly forever.

A key set to `false` still declares the plugin. That is a plugin installed and turned off, and its payload stays.

Dependencies are the exception a declaration cannot express. Claude Code installs a plugin named in another plugin's `dependencies` without writing a key for it, so the prune reads the manifest of every declared payload and keeps what it names. A bare name resolves against the marketplace the depending plugin came from.

An unreadable `settings.json` fails the run rather than pruning against an empty declaration, which would take every plugin on the machine. Uninstalling touches only ids the file does not name, so the pass writes nothing back and cannot dirty the tracked config and stall the next night at the sync gate.

A plugin the marketplace dropped keeps its declaration, so the prune leaves it and the audit reports it as `orphaned`. Removing the payload while `settings.json` still names it would leave an entry pointing at nothing.

### Auditing

`claude plugin update` exiting 0 is not evidence that anything changed. A plugin that declares a fixed `version` string reports "already at the latest version" however far its source has moved, and an id the updater never enumerated is never attempted at all. Both leave a stale install behind a successful run.

`claude-plugin-audit` checks the result instead. For a plugin that the marketplace carries in its own tree, it compares the installed payload against that tree, ignoring the runtime markers and installed dependencies that only ever exist on the payload side, and the provenance markers that only ever exist on the marketplace's. For a plugin living in its own repo, it compares the recorded commit against the sha the marketplace pins, or against what the remote points at when the marketplace pins nothing. It exits non-zero, listing what needs attention, and is worth running by hand for an on-demand answer.

The marketplace trees are checked too. Every other comparison reads them as ground truth, and `claude plugin marketplace update` warns rather than fails, so a tree that quietly stopped advancing would match a stale install and hide the drift from both sides. Claude Code clones some marketplaces and materializes others from GCS. Each records its origin differently: a clone has `.git` and answers to `rev-parse HEAD`, while a materialized tree holds the commit it was built from in a `.gcs-sha` file at its root. The audit resolves both against what the source ref points at. A tree carrying neither marker is reported as unverified, and so is one whose marker does not look like a commit sha, because a half-written one says nothing about the tree.

A payload is only as current as the tree it was compared against, so a plugin that matches a marketplace the audit could not vouch for is reported as unverified rather than current. Without that, one unchecked marketplace would hide every install it serves.

A comparison that could not be made is not a finding. At 3am an unreachable remote is a flaky network far more often than a real change, so unverified results print but do not fail the audit. An inventory the audit could not read is different: it exits 2 and reports nothing, because calling zero plugins current is the silence the tool exists to break.

The tree comparison is on content rather than the recorded `gitCommitSha`, because a forced refresh restores current content while leaving that field at its old value. A plugin sourced from its own repo has no local copy of that repo to compare against, so it falls back to the recorded commit and inherits the same inaccuracy.

A payload whose source still offers the version already installed is reported as `pinned` rather than stale. `claude plugin update` compares those two version strings, so nothing reaches the install however far the tree behind the version has moved, and the fix is the reinstall below. For a plugin living in its own repo, the offered version comes from the manifest at the commit the ref resolves to, read over GitHub's raw-content route rather than by cloning. A manifest the audit cannot read leaves the verdict at stale.

### Repairing a Flagged Plugin

`claude plugin uninstall <id>` then `claude plugin install <id>`. Deleting the payload and running `claude plugin update` does not work on the plugins most likely to be flagged: a version-keyed plugin reports `already at the latest version` whether or not the payload is even there, so the delete stands and the plugin ends up uninstalled behind a successful-looking update. Reinstalling also rewrites `gitCommitSha`, which a forced refresh leaves stale and permanently flagged for a plugin sourced from its own repo.

Payload directories carry an `.in_use` directory holding one file per session PID. Check those with `kill -0` before removing anything by hand. Deleting a payload out from under a live session breaks its skill loads until restart, which is why the audit only ever reports.

`claude-sync` runs the audit after updating and files its findings as a Things to-do on a latch separate from the sync's own. Drift outlives the run that should have fixed it, so one stale plugin sharing the sync latch would suppress the to-do for a later sync failure. The latch also holds a fingerprint of which plugins are flagged, so a plugin that goes stale months later reopens it instead of hiding behind one that has been stale all along.

## Computer Use

Claude Code's built-in `computer-use` MCP drives the macOS GUI with screenshots and mouse/keyboard input. [Peekaboo](https://github.com/steipete/peekaboo) is the accessibility-tree fallback for cases where screenshot perception is brittle or too costly: `peekaboo see` snapshots the AX tree with element IDs, then `peekaboo click`/`type` target those IDs. Call it from any agent via the CLI.

Both need **Screen Recording** and **Accessibility** granted in System Settings > Privacy & Security. They fail silently without them.
