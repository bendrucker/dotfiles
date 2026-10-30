# Rex

[Rex](https://www.superlogical.com/rex/docs) is a terminal multiplexer configured in Lua. `config/` links to `~/.config/rex`. Rex reads `init.lua` only on `rex config reload`, which the `rex:reload` task runs after a sync.

## Review Changes

Run **Review Changes** from the command palette with an agent's pane focused. It splits that pane and opens [tuicr](../tuicr/) on the uncommitted changes in the agent's directory, in the left two-thirds, with the agent in the right third.

Comment in tuicr, then press `y`. The review pastes into the agent's prompt, focus returns to the agent, and the review pane closes. The paste waits for you to press Enter. `:q` closes the pane without sending anything.

The action reads the agent's directory from its foreground process. That directory follows an agent that moved into another worktree. `config/review-pane` runs tuicr and hands the review back through Rex's `block.event` paste API, which applies the agent's bracketed paste mode.

## Failures

A failed action is logged by the server as `control invoke failed`:

```sh
rex server logs --state-dir "$HOME/Library/Application Support/rex" | grep 'control invoke failed'
```

When tuicr or the hand-back fails, the review pane shows the error and the review text, and closes when you press Enter.
