# fzf-links Custom Schemes

Extra schemes for [tmux-fzf-links](https://github.com/alberti42/tmux-fzf-links),
on top of the plugin's default file/url/git/code-error matchers. `search.conf`
points `@fzf-links-user-schemes-path` at `user_schemes.py`, which assembles the
schemes from `schemes.py`. Each module sits beside its `_test.py` sidecar.

## Schemes

| Pattern | Opens |
|---|---|
| `#123` | issue/PR on the current repo's forge (GitHub redirects `/issues/N` to `/pull/N` for PRs) |
| `!123` | GitLab merge request |
| `owner/repo#123` | issue/PR in another repo |
| `a1b2c3d` | commit page |
| `ENG-1234` | Linear issue |
| `localhost:3000` | dev-server URL |

## How the forge is resolved

The plugin `chdir`s into the pane's working directory before matching, so
`git_context.py` reads the remote from there with `pygit2` and parses the URL
with [`giturlparse`](https://github.com/nephila/python-giturlparse). A `#123` in
a pane sitting in a GitHub repo opens that repo's issue; the same token in a
GitLab repo opens a GitLab issue, and `!123` opens a merge request. No per-repo
configuration.

Each handler drops matches it can't resolve by returning `None`: `#`/`!`
patterns appear only inside a recognized repo, and a commit SHA must resolve in
the current repo before it becomes a link. So bare tokens stay quiet outside a
matching repo.

Handlers return `Candidate`/`Link` dataclasses (`results.py`) and take their git
and config dependencies by injection, so they unit-test without patching.
`schemes.py` is the only module that touches the plugin: it reads the tmux
options, constructs the handlers, and adapts the dataclasses to the dict shape
the plugin consumes.

## Linear

Linear is the only scheme that can't be inferred from the pane. Its workspace
slug is work-specific and stays out of this repo: `linear.py` reads
`@fzf-links-linear-workspace`, and Linear matches are dropped when it's unset.
Both options are work-specific, so set them in the gitignored
`~/.config/tmux/tmux.conf.local`:

```tmux
set -g @fzf-links-linear-workspace 'your-workspace'
set -g @fzf-links-linear-teams 'ENG'
```

`@fzf-links-linear-teams` is a space- or comma-separated list of team prefixes.
There is no default; Linear matches nothing until it's set.

## Interpreter and dependencies

`@fzf-links-python` points at the `python` shim, which runs the schemes under
`uv run`. uv provisions an interpreter matching `requires-python` and installs
`giturlparse` from `pyproject.toml`/`uv.lock` on first use, then serves both
from its cache (~50 ms warm). The nightly `dotfiles-upgrade` can run the shim
once to warm the cache so a cold first run never lands interactively.

## Tests

```sh
uv run pytest
```

The `_test.py` sidecars exercise the pure logic (URL parsing, the match/drop
boundaries of each pattern, URL construction) without a live tmux, git, or the
plugin installed. CI runs them in the `fzf-links` job.
