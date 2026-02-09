# Claude Code

Shell integration for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

## `ccw` — Claude in a worktree

Create a new [worktrunk](https://github.com/nicholasgasior/worktrunk) worktree and launch Claude in it:

```
ccw <branch>                      # interactive Claude session
ccw <branch> -- 'fix the bug'    # Claude with a prompt
```

Arguments after `--` are forwarded to `claude`.

## Aliases

| Alias | Expands to |
|-------|-----------|
| `ccw` | `wt switch --create --execute=claude` |
| `sonnet` | `claude --model sonnet` |
