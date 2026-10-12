# Link Schemes

Turns a token printed in a pane into the URL it refers to: `#123` into an issue
on the repo the pane is sitting in, `ENG-1234` into a Linear issue, a bare SHA
into a commit page.

Nothing in this repo calls these handlers. Their last host, tmux-fzf-links,
scanned a pane's scrollback and offered every match through fzf, and it went out
with tmux. herdr's `[[link_handlers]]` takes a per-plugin regex that makes
matching text Ctrl-clickable, so porting this means a small herdr plugin
wrapping these handlers rather than a picker over the whole screen. CI keeps
running the tests so the scheme logic stays correct until that port lands. Each
module sits beside its `_test.py` sidecar.

## Schemes

| Pattern | Opens |
| --- | --- |
| `#123` | issue/PR on the current repo's forge; labeled `[PR]` when the token is a hyperlinked pull request (see below) |
| `!123` | GitLab merge request |
| `owner/repo#123` | issue/PR in another repo |
| `a1b2c3d` | commit page |
| `ENG-1234` | Linear issue |
| `localhost:3000` | dev-server URL |

## OSC 8 hyperlink targets

Tools like Claude Code, `gh`, and `delta` print refs as
[OSC 8 hyperlinks](https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda):
the visible text is `#497` but the escape sequence carries the real target,
`https://github.com/owner/repo/pull/497`. That URL already encodes the
issue-vs-PR distinction, with no API call or per-repo cache.

`osc8.py` re-captures the pane with escape sequences intact, parses it into a
visible-text → target-URL index, and the reference handlers prefer that target
when a matched token was hyperlinked. So `#497` linked to `/pull/497` opens the
PR directly and shows `[PR]`. An un-hyperlinked `#123` falls back to
forge-guessing `/issues/N` (GitHub redirects that to `/pull/N` for PRs
anyway). Commit and `owner/repo#N` matches likewise open their exact target
when one is present.

## How the forge is resolved

The host `chdir`s into the pane's working directory before matching, so
`git_context.py` reads the remote from there with `pygit2` and parses the URL
with [`giturlparse`](https://github.com/nephila/giturlparse). A `#123` in
a pane sitting in a GitHub repo opens that repo's issue. The same token in a
GitLab repo opens a GitLab issue, and `!123` opens a merge request. No per-repo
configuration.

Each handler drops matches it can't resolve by returning `None`: `#`/`!`
patterns appear only inside a recognized repo, and a commit SHA must resolve in
the current repo before it becomes a link. So bare tokens stay quiet outside a
matching repo.

Handlers return `Candidate`/`Link` dataclasses (`results.py`) and take their git
and config dependencies by injection, so they unit-test without patching.
`schemes.py` is the only module that touches its host: it reads the host's
options, constructs the handlers, and adapts the dataclasses to the shape the
host consumes. A port rewrites that module and leaves the rest alone.

## Linear

Linear is the only scheme that can't be inferred from the pane. It needs a
workspace slug and a list of team prefixes, both work-specific, so both stay out
of this repo and out of any tracked config. `linear.py` takes them as
constructor arguments and drops every Linear match when the workspace is unset,
which is what keeps this repo publishable. A port has to give them an untracked
home again.

## Interpreter and dependencies

The `python` shim runs the schemes under `uv run`. uv provisions an interpreter
matching `requires-python` and installs `giturlparse` and `pygit2` from
`pyproject.toml`/`uv.lock` on first use, then serves them from its cache (~50 ms
warm). A host that invokes this on a keystroke wants that cache warm, since a
cold first run otherwise lands in front of the user.

## Tests

```sh
uv run pytest
```

The `_test.py` sidecars exercise the pure logic (URL parsing, the match/drop
boundaries of each pattern, URL construction) without a live multiplexer, git,
or a host plugin installed. CI runs them in the `links` job.
