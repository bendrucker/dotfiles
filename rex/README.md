# Rex

[Rex](https://www.superlogical.com/rex/docs) is a terminal multiplexer configured in Lua. `config/` links to `~/.config/rex`. Rex reads `init.lua` only on `rex config reload`, which the `rex:reload` task runs after a sync.

## App Settings

`settings.json` holds the Mac app settings shared across machines, keyed by the action name after `client.setting.`. Run `rex -C <client> actions` to list the names and the values each takes. The `rex:settings` task, which runs after every `rex:reload`, sets each one with `rex do client.setting.<name>`. The task passes each action an explicit value rather than letting it toggle, so a setting that already matches stays as it is.

The app accepts these actions only while it's running with Remote Control on, under Settings > General > Client Info. When the server or app is missing, or the app refuses, the task warns and exits 0. A theme name only resolves once the theme is imported on that Mac, and the app rejects it until then. The task skips that setting and keeps going.

Window geometry, the sidebar's state, and server settings stay in `defaults` on each machine.

## Trying a Worktree's Config

Run `mise run rex:try` from a worktree to load its `rex/config` into the running server, and `mise run rex:restore` to go back to the deployed config. Pass a worktree path to `rex:try` to load one other than the current one.

The server fixes its config path when it starts, so `rex:try` leaves `~/.config/rex` alone. It writes the worktree's `init.lua` path to `~/.local/state/rex-try/config`, and the deployed `init.lua` loads that file instead of itself. Every reload, including the nightly one, keeps loading the worktree until `rex:restore` removes the pointer. A pointer to a removed worktree falls back to the deployed config.

## Review Changes

`config/review/` is a self-contained Rex plugin, which `init.lua` loads with `dofile(config_dir .. "/review/init.lua")`.

Run **Review Changes** from the command palette with an agent's pane focused. It runs `plannotator-tui rex review`, which opens a split beside the agent's pane on the agent's repository. An agent can open one itself with `rex do review_changes block="$REX_BLOCK" base=<ref>`, where every argument is optional. From the palette, it asks for the app, a base, and for Hunk a mode. `rex do` never prompts. With `base`, the diff runs from that ref to the working tree. `doc=<file>` runs `plannotator-tui rex open <file> --gate` instead, which adds Approve. plannotator-tui sends feedback to the agent itself, with `E` to send and `S` to send and close.

**Review Branch** opens the same review from where the branch forked from `origin/HEAD`, and **Review Last Commit** from `HEAD~1`. Both include uncommitted changes, and both take `app=hunk` too.

`app=hunk` opens [Hunk](../hunk/) through `config/review/review`, which couples it to the agent. Press `c` on a line to leave a note, then end the round with a key from either pane:

| Key | Action | The agent receives |
| --- | --- | --- |
| `cmd+s` | Review: Send | `[review: changes]` with each new comment, its location and quoted code, and how to answer it |
| `shift+cmd+a` | Review: Approve | `[review: approved]` |
| `shift+cmd+x` | Review: Dismiss | `[review: dismissed]`, which it treats as a success |

Each message is submitted to the agent and explains itself, without a prompt or rule on the agent's side. Send focuses the agent. The agent fixes each comment and answers it by piping `{"id": ..., "text": ...}` to `rex do review_reply --args -`, which keeps the reply out of shell quoting. When its turn ends, focus returns to the review, with the agent's answers shown as `Claude` replies under each note. Hunk keeps notes only while its window is open. Approve and Dismiss close the review. Quitting Hunk or closing its pane approves once every note has a reply, and otherwise sends `[review: closed]` with what is still open.

Hunk loads `config/review/hunk-extension.ts`. In a live Hunk review (`mode=live`), saving a note signals `run` to deliver it at once, and `ctrl+g` holds notes until pressed again, when the backlog arrives in order. The status line shows whether notes are live or held, how many delivered notes are open or answered, and when Claude is working. `run` keeps that status in `<agent-block>.status.json` beside the events file.

Outside a Hunk review's two panes, Rex sends the keys to the program. A review records its panes in `~/.local/state/rex-review/blocks/`, which `init.lua` checks on each key press.

The action reads the agent's directory from its foreground process. That directory follows an agent that moved into another worktree.

### Reviewer Adapters

`config/review/review` runs the loop, and `config/review/hunk.ts` holds everything specific to Hunk, behind the `Reviewer` interface in `config/review/reviewer.ts`. Another reviewer needs one more adapter that starts it, reads its comments, and adds the agent's replies. `config/review/tuicr.ts` adapts [tuicr](../tuicr/), which `DEFAULT_REVIEWER` in `config/review/review` switches back to.

Replies go through a Rex action, which finds the review's window from its state, so the agent needs only the comment id. The server runs `rex.exec` outside the agent's sandbox, which tuicr needs to write its storage under `~/Library/Application Support/tuicr`.

## Browser

Run **Open Browser** from the command palette to open [terminal-browser](https://terminal-browser.com) in a split to the right of the focused pane. When a browser is already open beside that pane, it opens a tab there instead. `terminal-browser:install` installs it and upgrades it on every install, which restarts any browser that is open.

## Background Agents

Run **Claude Agents** from the command palette to open `claude agents` in a floating pane along the right edge of the tab, a quarter of its width. It starts in the focused pane's directory, so sessions you dispatch from it start there too. Quitting the agent view closes the pane.

Attaching from the agent view opens the session inside that narrow pane. To work in a session, run **Attach Claude Session** instead. It opens a picker in the command palette listing background sessions and the interactive ones Rex panes show, with sessions waiting on you first. Typing filters the list. The items after the sessions narrow it to sessions that need input, hide finished ones, or show them all again.

Picking a session focuses the pane already showing it. Otherwise a second picker chooses where `claude attach` runs:

| Choice | Opens |
| --- | --- |
| Tab | A new tab in the Rex session labeled for the session's repo, or one with a pane in that repo |
| Split | A pane split to the right of the pane you ran the action from |
| Float | A floating pane over that tab |

`rex-claude-attach <id|name>` does the same from a shell, with `--as tab|pane|float` in place of the second picker. `--no-focus` leaves focus where it is and marks the session's tab or pane unread, so a background session that needs you shows in Activity without pulling you to it. `rex-claude-attach --list` prints the sessions the picker offers, as JSON.

### Known Rex Bugs

- Focus set after a `rex.ui.pick` snaps back when the picker closes ([Discord](https://discord.com/channels/1546797889009881158/1573463677779181669)), so picking a session a pane already shows can leave focus where it was. A new tab keeps focus.
- A floating pane opened right after a `rex.ui` prompt may not get focus ([Discord](https://discord.com/channels/1546797889009881158/1572841696285298688)).
- The Mac app can ignore a new or changed Lua action after `rex config reload` until it is relaunched.

## Failures

A failed action is logged by the server as `control invoke failed`:

```sh
rex server logs --state-dir "$HOME/Library/Application Support/rex" | grep 'control invoke failed'
```

A failed review key logs its error to the server log as a warning. When the reviewer itself exits with an error, the agent receives `[review: failed]`.
