# Rex

[Rex](https://www.superlogical.com/rex/docs) is a terminal multiplexer configured in Lua. `config/` links to `~/.config/rex`. Rex reads `init.lua` only on `rex config reload`, which the `rex:reload` task runs after a sync.

## Trying a Worktree's Config

Run `mise run rex:try` from a worktree to load its `rex/config` into the running server, and `mise run rex:restore` to go back to the deployed config. Pass a worktree path to `rex:try` to load one other than the current one.

The server fixes its config path when it starts, so `rex:try` leaves `~/.config/rex` alone. It writes the worktree's `init.lua` path to `~/.local/state/rex-try/config`, and the deployed `init.lua` loads that file instead of itself. Every reload, including the nightly one, keeps loading the worktree until `rex:restore` removes the pointer. A pointer to a removed worktree falls back to the deployed config.

## Review Changes

`config/review/` is a self-contained Rex plugin, which `init.lua` loads with `dofile(config_dir .. "/review/init.lua")`.

Run **Review Changes** from the command palette with an agent's pane focused. It opens `plannotator-tui review` on the agent's uncommitted changes, in a split taking the right three-quarters of the agent's pane. An agent can open one itself with `rex do review_changes block="$REX_BLOCK" base=<ref>`, where both arguments are optional. With `base`, the diff runs from that ref to the working tree, so uncommitted changes show too. `app=hunk` opens [Hunk](../hunk/) instead.

**Review Branch** opens the same review from where the branch forked from `origin/HEAD`, and **Review Last Commit** from `HEAD~1`. Both include uncommitted changes, and both take `app=hunk` too.

Select lines with `v` or a drag and press `c` to leave a note (in Hunk, `c` on a line), then end the round with a key from either pane:

| Key | Action | The agent receives |
| --- | --- | --- |
| `cmd+s` | Review: Send (Hunk) | `[review: changes]` with each new comment, its location and quoted code, and how to answer it |
| `shift+cmd+a` | Review: Approve | `[review: approved]` |
| `shift+cmd+x` | Review: Dismiss | `[review: dismissed]`, which it treats as a success |

Each message is submitted to the agent and explains itself, without a prompt or rule on the agent's side. Send focuses the agent. The agent fixes each comment and answers it with `rex do review_reply id=<id> text=<reply>`. When its turn ends, focus returns to the review, with the agent's answers shown as `Claude` replies under each note. Hunk keeps notes only while its window is open. Approve and Dismiss close the review. Quitting the reviewer or closing its pane approves once every note has a reply, and otherwise sends `[review: closed]` with what is still open.

In a diff review, plannotator-tui sends notes itself: its `E` pastes them into the agent's pane, and `run` points it there, so it skips its agent picker. Its feedback names each note by file and line, so the agent replies with `id=<path>:<line>`. Send refuses there, and `run` streams none of its notes in live mode. A document review keeps streaming notes with their ids. Approve and closing the pane skip notes it already sent. Hunk loads `config/review/hunk-extension.ts`. In a live Hunk review, saving a note signals `run` to deliver it at once, and `ctrl+g` holds notes until pressed again, when the backlog arrives in order. The status line shows whether notes are live or held, how many delivered notes are open or answered, and when Claude is working. `run` keeps that status in `<agent-block>.status.json` beside the events file.

Outside a review's two panes, Rex sends the keys to the program. A review records its panes in `~/.local/state/rex-review/blocks/`, which `init.lua` checks on each key press.

The action reads the agent's directory from its foreground process. That directory follows an agent that moved into another worktree.

### Reviewer Adapters

`config/review/review` runs the loop, and `config/review/hunk.ts` holds everything specific to Hunk, behind the `Reviewer` interface in `config/review/reviewer.ts`. Another reviewer needs one more adapter that starts it, reads its comments, and adds the agent's replies. `config/review/tuicr.ts` adapts [tuicr](../tuicr/), which `DEFAULT_REVIEWER` in `config/review/review` switches back to.

Replies go through a Rex action, which finds the review's window from its state, so the agent needs only the comment id. The server runs `rex.exec` outside the agent's sandbox, which tuicr needs to write its storage under `~/Library/Application Support/tuicr`.

## Background Agents

Run **Claude Agents** from the command palette to open `claude agents` in a floating pane along the right edge of the tab, a quarter of its width. It starts in the focused pane's directory, so sessions you dispatch from it start there too. Quitting the agent view closes the pane.

Attaching from the agent view opens the session inside that narrow pane. To work in a session, run **Attach Claude Session** instead. It lists background sessions and the interactive ones Rex panes show, with sessions waiting on you first. Typing searches session names. Ctrl-W narrows the list to sessions that need input, Ctrl-O hides finished ones, and Ctrl-A shows them all again.

Picking a session focuses the pane already showing it. Otherwise the key you pick with says where `claude attach` runs:

| Key | Opens |
| --- | --- |
| Enter | A new tab in the Rex session labeled for the session's repo, or one with a pane in that repo |
| Ctrl-V | A pane split to the right of the pane you ran the action from |
| Ctrl-F | A floating pane over that tab |

`rex-claude-attach <id|name>` does the same from a shell, with `--as tab|pane|float` in place of the key. `--no-focus` leaves focus where it is, for a background session that needs you to pull itself up.

## Failures

A failed action is logged by the server as `control invoke failed`:

```sh
rex server logs --state-dir "$HOME/Library/Application Support/rex" | grep 'control invoke failed'
```

A failed review key logs its error to the server log as a warning. When the reviewer itself exits with an error, the agent receives `[review: failed]`.
