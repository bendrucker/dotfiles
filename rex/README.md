# Rex

[Rex](https://www.superlogical.com/rex/docs) is a terminal multiplexer configured in Lua. `config/` links to `~/.config/rex`. Rex reads `init.lua` only on `rex config reload`, which the `rex:reload` task runs after a sync.

## Review Changes

Run **Review Changes** from the command palette with an agent's pane focused. It opens [tuicr](../tuicr/) on the agent's uncommitted changes, in a split taking the left two-thirds of the agent's pane. An agent can open one itself with `rex do review_changes block="$REX_BLOCK" revisions=<base>..HEAD`, where both arguments are optional.

Comment in tuicr, then end the round with a key from either pane:

| Key | Action | The agent receives |
| --- | --- | --- |
| `cmd+s` | Review: Send | `[review: changes]` with each new comment, its location and quoted code, and how to answer it |
| `shift+cmd+a` | Review: Approve | `[review: approved]` |
| `shift+cmd+x` | Review: Dismiss | `[review: dismissed]`, which it treats as a success |

Each message is submitted to the agent and explains itself, without a prompt or rule on the agent's side. Send focuses the agent. The agent fixes each comment and answers it with `rex do review_reply id=<id> text=<reply>`. When its turn ends, focus returns to the review, with the agent's answers shown as `[@Claude]` comments. Approve and Dismiss close the review. Quitting tuicr or closing its pane dismisses it.

Outside a review's two panes, Rex sends the keys to the program. A review records its panes in `~/.local/state/rex-review/blocks/`, which `init.lua` checks on each key press.

The action reads the agent's directory from its foreground process. That directory follows an agent that moved into another worktree.

### Reviewer Adapters

`config/review/review` runs the loop, and `config/review/tuicr.ts` holds everything specific to tuicr, behind the `Reviewer` interface in `config/review/reviewer.ts`. Another reviewer needs one more adapter that starts it, reads its comments, and adds the agent's replies.

Replies go through a Rex action because the server runs `rex.exec` outside the agent's sandbox, and the sandbox can't write tuicr's storage under `~/Library/Application Support/tuicr`.

## Failures

A failed action is logged by the server as `control invoke failed`:

```sh
rex server logs --state-dir "$HOME/Library/Application Support/rex" | grep 'control invoke failed'
```

A failed review key logs its error to the server log as a warning. When tuicr itself exits with an error, the agent receives `[review: failed]`.
