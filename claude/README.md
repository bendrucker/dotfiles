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

`cwp` reads the pasteboard and passes it as Claude's initial prompt — paste an issue URL or Linear prompt, then run `cwp <branch>`.
