# Dotfiles

Personal dotfiles for macOS. Everything outside `macos/` must also work on Linux. `bin/` is on `$PATH`. In each topic directory, every `*.zsh` file is sourced at shell startup, and `path.zsh` is sourced first.

## Nightly Job Constraints

`bin/dotfiles-upgrade` runs `scripts/install` unattended at 3am on a locked Mac. Every step it reaches must follow these rules:

- Never block on input. Gate any `sudo` or prompt on an interactive terminal and skip it otherwise, as `ssh/install.sh` does.
- Never fetch over SSH, because Secretive refuses to sign while the Mac is locked. When an installer clones from GitHub, wrap the clone in a subshell that calls `git_https_env owner/repo ...` from `scripts/shell/git-sync.sh`, as `herdr/install.sh` does.
- Never uninstall or delete on an ambiguous finding. Report it through `#jobs/report` instead.
- Downgrade a failing post-install step (reload, drift, migration) to a warning rather than failing the run.

`dotfiles sync` only fast-forwards and reloads. Run `scripts/install` or `dotfiles sync --bootstrap` to converge.

## Adding a Tool

Put a tool that needs only a Brewfile line and a few aliases in an existing topic, in a file named for what it does, like `system/ls.zsh` or `system/networking.zsh`. Use `system/` when no topic fits. Give a tool its own directory only when it has config files to link, an installer, a `mise.toml`, or more shell config than one file holds.

Declare a new tool in its topic's `Brewfile`. Use the topic's `mise.toml` instead only when the version must vary per project, as with language runtimes and `terraform`.

Pin a tool that this repo's own scripts, tests, or CI call in `system/mise.toml`, and declare it in no Brewfile. `gum` is the exception and stays on Homebrew, because `scripts/homebrew.sh` installs it before mise exists. A Claude Code cloud session has no Homebrew, so `system/mise.remote.toml` pins it there, and `.claude/hooks/session-start` installs both files.

Mark a formula `ci: :extra` when nothing in this repo configures it, calls it, or loads it at shell startup. Remove the marker in the same change that gives it a config file or a caller.

Add npm and Go CLIs as `"npm:<pkg>"` or `"go:<module>"` under `[tools]` in the owning topic's `mise.toml`. For a Go tool installed from below its module root, like `.../cmd/dlv`, Renovate resolves the root through a GitHub-only rule in `.github/renovate.json`. Widen that rule for a module hosted elsewhere, or Renovate's lookup fails with only a warning.

Run a topic's `install.sh` from a `[tasks."<topic>:install"]` in its `mise.toml`. `mise/tasks.test.ts` fails on an installer without one. Put a one-line installer in the task's `run` instead of a script.

When the tool stores a credential, add its entry to the `CREDENTIALS` table in `credentials/bin/credential-audit` in the same change. A tool missing from that table is unexamined, not safe.

## Machine-Local Configuration

This repo is public and installs identically on every machine. Put anything specific to one machine or employer in an untracked `.local` file, and never name its contents in the repo.

| Include point | Loaded by | Holds |
| --- | --- | --- |
| `~/.zshenv.local` | `zsh/.zshenv`, last, so it can override `$PATH` | Env vars and `$PATH` for every shell |
| `~/.localrc`, `~/.zshrc.local` | `zsh/.zshrc`, before topic files, which override it | Interactive-only shell config |
| `~/Brewfile.local` | root `Brewfile` | Employer-mandated and machine-specific packages |
| `~/.config/git/config.local` | `git/config` `[include]` | Identity, credential helper, per-org identities |
| `~/.ssh/config.local` | `ssh/config` `Include` | Work hosts, jump hosts, the Secretive `Host *` fallback |

Never add employer-specific tooling to a topic directory. When shell history shows a heavily used tool with no topic, assume a `.local` file declares it. Ask whether it belongs in `~/Brewfile.local` before proposing a topic.

## mise Config

`~/.config/mise/conf.d` links to the dotfiles root, so every topic's `mise.toml` is global config, merged alphabetically.

Pin every mise tool to an exact version, never `"latest"`, so Renovate can track it. When a version is a template, like `uv` in `python/mise.toml`, keep its default in `[vars]` under a `# renovate:` comment. Disable the mise manager for that tool in `.github/renovate.json`, or Renovate replaces the template with a literal.

A tool mise installs for one project still gets a shim ahead of `$HOMEBREW_PREFIX/bin`, which costs ~125ms per spawn everywhere else. When `scripts/mise-shim-shadows` names one, clear it with `mise uninstall <tool> --all && mise reshim`, or add the command to `shims.exclude` in the topic that declares the Homebrew copy, as `nodejs/mise.toml` does for `bun`.

A topic's `mise.<env>.toml` loads only while `mise/miserc.toml.tera` selects `<env>` for the machine. Put a `[bootstrap.macos.launchd.agents]` entry there when its program may be missing or the nightly job must not reload it under itself. Deselecting a module leaves its agent loaded, so pair that change with a migration that removes the agent.

## Config Files

Declare links under `[dotfiles]` in the topic's `mise.toml`, keyed by target, with the source relative to the topic. Write targets as `~/.config/...`, not `$XDG_CONFIG_HOME`. `scripts/install-symlinks` applies them with `mise dot apply --force`, which replaces whatever sits at a target.

Use a directory `source` when new files in it should go live without another install. When the tool writes its own state there, add a `.gitignore` inside it, as `herdr/plugins/config` does.

Links resolve through `conf.d` to `~/.dotfiles`, so an edit in a worktree has no effect until it merges and syncs. To try one sooner:

- `dotfiles test` replaces the current shell with one that loads the worktree.
- `dotfiles dev enable` repoints every link at the worktree until `dotfiles dev disable`.
- For a tool that reloads at runtime, pass it the worktree path. A reload by the installed path follows the link to `~/.dotfiles` and reads the wrong copy.
- `mise/docker-test` runs the worktree's mise setup in a throwaway Linux container, without Homebrew or topic installers.

## Removing Installed State

When a change stops declaring something a machine already has (a Brewfile package, a `[dotfiles]` link, a LaunchAgent), add a migration under `migrations/` in the same commit. Put one-time cleanup there, not in `scripts/install` or a topic installer, even when it is idempotent. `migrations/CLAUDE.md` covers writing one.

## Config Reloads

Add a `<topic>:reload` task, running `reload.sh` with `timeout = "60s"`, only for a tool that can re-read its config in place. Never restart a server, kill a session, or drop in-flight work from a reload, because the 3am job runs it unattended. `moshi:reload` is the one sanctioned exception. Do not copy it.

Exit 0 without doing anything when the tool is not installed or not running.

## Tests

Put a test beside what it covers, named after it: `scripts/install-taps.test.ts` covers `scripts/install-taps`. Test shell scripts from TypeScript with `#harness`. Run `bun run test` to match the `bun` job, since bare `bun test` runs files serially. It points `GIT_CONFIG_GLOBAL` at `/dev/null` so fixture commits never reach your signing agent, and keeps that out of `bunfig.toml` because the integration tests read the installed git config. It records each file's duration in `tmp/test-timings.json` and starts the slowest files first on the next run. Run `mise run lint` to match the `lint` job.

To call a shell library function directly, source the library inside a `shell()` snippet. Functions redefined after the `source` line override the library's.

The test's name and location pick its CI job:

- `*.test.ts` run in the `bun` job on a bare checkout. Stub everything the script under test calls.
- `*.integration.test.ts` run in the `bootstrap` job on Linux and macOS after a full install, and read installed config through its links. Add no guard that lets one pass on an unbootstrapped machine. Skip only for a genuinely optional dependency, as `bin/glyph-scan.integration.test.ts` does.
- Tests under `.claude/skills/` and `.claude/hooks/` run in the `skill-tests` job, whatever their suffix.
- `scripts/lint-ts.test.ts` runs in `lint:ts`, and the `bun` job ignores it by path.

On a PR, `bootstrap` installs main, installs the PR head over it, then installs again. On macOS that is a PR's only pass, so a fresh install there waits for main's push and the nightly. The last two installs must leave identical links, packages, and tools, so every install step must converge.

When a test stubs a dependency of a `#!/usr/bin/env zsh` script, set `ZDOTDIR` to an empty directory. Otherwise `~/.zshenv` runs `brew shellenv`, which can put `$HOMEBREW_PREFIX/bin` ahead of the stub, and the test passes locally but fails in CI.

```ts
run([script, ...args], { cwd: box.dir, path: [box.bin], env: { ZDOTDIR: box.mkdir("empty") } });
```

## TypeScript

Import a module under `packages/` by its `#` specifier from the root `package.json` `imports`, never by relative path. Lint rejects a relative path into `packages/`.

Add no runtime dependency to `packages/` or to anything `bin/dotfiles-sync` reaches. The 3am jobs run `bin/*` under bun from a clone with nothing installed.

Write `scripts/shell/` as POSIX sh sourced by relative path. `scripts/setup` and `bin/dotf` source it before bun or gum exist.

Lint with `mise run lint:ts`. Never run `oxlint` or `bunx oxlint` directly, because plain `oxlint` skips the extensionless `bin/` executables and `bunx` ignores the pinned version.

Strip ANSI from child output with `Bun.stripANSI`. Use a hand-rolled regex only to strip something narrower, and put `oxlint-disable-next-line no-control-regex` above it.

The size and complexity caps in `.oxlintrc.json` sit at the tree's current maximum. `max-depth` and `max-params` fail on any increase. When code exceeds a cap, split it instead of raising the threshold. Add an `oxlint-disable-next-line` that names the reason only for a function that is wide rather than deep, such as a decision table or a run of flag handlers.

## ZSH Startup Performance

CI fails a change whose median interactive zsh startup exceeds 1s.

- In `.zsh` files, use `$HOMEBREW_PREFIX`. Never call `brew --prefix`.
- Guard every `$(...)` or backtick that runs at startup. Each fork costs 15-50ms.
- Put completion registration (`compdef`, `eval "$(tool completion zsh)"`) in `<topic>/completion.zsh`, singular. `.zshrc` defers only that filename to a one-shot `zle-line-init` hook, and `lint:completion-naming` rejects `completions.zsh`. Put other interactive-only setup there too. A `precmd` hook doesn't defer anything, since it runs before the prompt draws.
- Put topic `.zsh` files directly in the topic directory. The loaders glob `$ZSH/*/` only, so a nested `.zsh` file is never sourced, and the `lint` job's zsh-depth check fails on one.
- Put `$PATH` changes in `<topic>/path.zsh`, which only `.zshenv` sources. Keep `DOTFILES_ZSHENV_RAN` unexported. Do not install a second `.zshenv` under `$ZDOTDIR`, since every `#!/usr/bin/env zsh` script would pay ~110ms for it.
- Measure a change with `bench-startup [other-worktree]`.
