# dotfiles [![tests](https://github.com/bendrucker/dotfiles/actions/workflows/test.yml/badge.svg)](https://github.com/bendrucker/dotfiles/actions/workflows/test.yml)

> My dotfiles for configuring macOS

Linux-friendly, outside of [`macos/`](macos/) and a [`Brewfile`](Brewfile) for dependency management. I use this repo for both home and work.

Highlights include:

* zsh with the minimal [pure](https://github.com/sindresorhus/pure) prompt
* Sub-second shell startup, [enforced by CI](#startup-budget)
* Sane defaults for programming languages I use

## Installing

```sh
git clone https://github.com/bendrucker/dotfiles.git ~/.dotfiles
cd ~/.dotfiles
scripts/bootstrap
```

## How It Works

Everything is organized into **topic** directories: [`git/`](git/), [`zsh/`](zsh/), [`herdr/`](herdr/), and so on. A topic is a directory that follows a few naming conventions. Bootstrap and startup glob for those conventions across every topic. Adding a tool means creating a directory and dropping in the right files, with no central list to register in.

### Topic Conventions

A file's name determines how and when it loads:

| File | Purpose |
| --- | --- |
| `path.zsh` | Sourced first, from `.zshenv`, to set up `$PATH`. |
| `*.zsh` | Sourced at interactive shell startup. Aliases, functions, options. |
| `completion.zsh` | Sourced lazily after the first prompt (see [startup budget](#startup-budget)). |
| `symlinks.conf` | Declares config files to symlink into `$HOME` or `~/.config`. |
| `Brewfile` | Homebrew packages for the topic. |
| `mise.toml` | Pinned language/tool versions, merged into mise's config. |
| `install.sh` | Non-symlink setup: plugin managers, system config. Run by `scripts/install`. |
| `reload.sh` | Tells an already-running program to re-read its config (see [config reloads](#config-reloads)). |
| `*.test.ts` | A [test](#tests) sitting next to whatever it covers. |

The repo-root [`bin/`](bin/) holds executables that go on `$PATH`, like `dotfiles-upgrade` and `bench-startup`.

What those executables share lives in [`packages/`](packages/), imported by specifier rather than by relative path: `#harness` for the test harness, `#jobs/*` for what the unattended jobs have in common, `#worktree/*` for worktrunk state, and `#plugins` for the installed Claude Code plugins. The root `package.json` maps them, and Bun resolves that with no `node_modules` and no install step, which is what lets the 3am jobs run straight from a fast-forwarded clone. [`scripts/shell/`](scripts/shell/) is the POSIX floor beneath it, sourced by `scripts/setup` and `bin/dotf` before bun is installed.

### Shell Startup

zsh startup is a glob-driven loader split across two files, following zsh's own load order:

1. [`zsh/.zshenv`](zsh/.zshenv) (symlinked to `~/.zshenv`) runs on **every** shell, interactive or not. It resolves which dotfiles root is active (see [dev mode](#dev-mode-and-testing)), runs `brew shellenv`, sources every `path.zsh`, then forces the repo's own `bin/` to the front of `$PATH`:

   ```zsh
   for file in $ZSH/**/path.zsh; do source $file; done
   typeset -gU path
   path=("$ZSH/bin" "$HOME/.local/bin" $path)
   ```

2. [`zsh/.zshrc`](zsh/.zshrc) (symlinked into `$ZDOTDIR`) runs on interactive shells. It globs every topic's `.zsh` files and sources all of them **except** the path and completion files, which are handled separately:

   ```zsh
   config_files=($ZSH/**/*.zsh)
   for file in ${${config_files:#*/path.zsh}:#*/completion.zsh}; do
     source $file
   done
   ```

`.zshenv` runs on every shell only from the top of a process tree. zsh reads its per-user `.zshenv` from `$ZDOTDIR` and falls back to `~/.zshenv` only when `ZDOTDIR` is unset, and `.zshenv` exports `ZDOTDIR` while `zsh/symlinks.conf` installs just `.zshrc` there. Every zsh below the first one therefore finds no `.zshenv`, skips the `path.zsh` loop, and keeps whatever `$PATH` its parent froze. `.zshrc` sources `.zshenv` itself when a marker shows it has not run, so an interactive shell under a server started weeks ago still sees a topic added since. Non-interactive nested shells stay on the inherited `$PATH`, which is what keeps a `#!/usr/bin/env zsh` script at ~6ms rather than ~110ms.

Completions are the expensive part of startup. They don't run before the first prompt. `.zshrc` registers a one-shot `precmd` hook that sources every `completion.zsh` after the prompt is already interactive, then removes itself:

```zsh
_load_deferred_completions() {
  add-zsh-hook -d precmd _load_deferred_completions
  for file in $ZSH/**/completion.zsh; do source $file; done
}
add-zsh-hook precmd _load_deferred_completions
```

### Startup Budget

[CI benchmarks startup](.github/workflows/test.yml) with [hyperfine](https://github.com/sharkdp/hyperfine) and **fails the build if median startup exceeds one second**:

```sh
hyperfine --warmup 3 --runs 10 --shell=none 'zsh -i -c exit'
# median > 1.0s → exit 1
```

The same job dumps a per-file [`zprof`](https://zsh.sourceforge.io/Doc/Release/Zsh-Modules.html#The-zsh_002fzprof-Module) self-time table into the run summary. A few rules keep startup fast, documented in [`CLAUDE.md`](CLAUDE.md):

* **No subshell forks during startup.** Each `$(...)` costs ~15-50ms. `brew --prefix` is banned in favor of the already-exported `$HOMEBREW_PREFIX`.
* **`compinit -C`** skips the completion security audit on every startup. The full audit runs during the nightly upgrade instead.
* **Completions defer** via the `precmd` hook above. Because the deferral filter matches `completion.zsh` exactly, a file named `completions.zsh` (plural) would load eagerly and bypass it. CI [greps for that mistake](.github/workflows/test.yml) and fails.

`bin/bench-startup` measures the current worktree, or compares two.

### Declarative Symlinks

Config files are linked into place from per-topic [`symlinks.conf`](git/symlinks.conf) files in `source:target` format, one per line. Targets expand `~` and `$XDG_CONFIG_HOME`:

```ini
# git/symlinks.conf
config:$XDG_CONFIG_HOME/git/config
delta-catppuccin.gitconfig:$XDG_CONFIG_HOME/git/delta-catppuccin.gitconfig
ignore:$XDG_CONFIG_HOME/git/ignore
```

[`scripts/install-symlinks`](scripts/install-symlinks) globs every `symlinks.conf`, creates the links, and validates each source exists. It also **prunes**: a symlink that points into the dotfiles repo but is no longer declared gets removed. Dropping a line from `symlinks.conf` is enough to unlink the file it used to manage.

### Homebrew Aggregation

The root [`Brewfile`](Brewfile) recursively evaluates every topic `Brewfile`. `brew bundle` from the repo root installs everything:

```ruby
Dir.glob(File.join(File.dirname(__FILE__), '*', '**', 'Brewfile')) do |brewfile|
  eval(IO.read(brewfile), binding)
end
```

Passing `binding` means topic Brewfiles inherit the root's overridden `brew`/`cask`/`mas` methods, which add two behaviors:

* **Duplicate detection.** `brew bundle` installs in parallel. A package declared in two Brewfiles races on the Homebrew lock and aborts with a cryptic error. An `assert_unique_package` guard fails fast on the duplicate instead.
* **CI trims GUIs.** When `$CI` is set, `cask` and `mas` skip their installs so runners don't pull slow GUI apps.

A `~/Brewfile.local` is evaluated last, if present, for machine-specific packages that shouldn't live in the repo.

### Language Versions with mise

Each language topic pins its versions in a `mise.toml` and links it into [mise](https://mise.jdx.dev/)'s drop-in config directory through its `symlinks.conf`, namespaced by topic:

```ini
# go/symlinks.conf
mise.toml:$XDG_CONFIG_HOME/mise/conf.d/go.toml
```

mise merges everything in `conf.d/` automatically. Each topic owns its runtime versions without a shared config file. Versions are pinned exactly (never `latest`) so [Renovate](https://github.com/renovatebot/renovate) can track and bump them.

#### Choosing mise or Homebrew for a Tool

Homebrew is the default. It links binaries into `$HOMEBREW_PREFIX/bin`, a path that stays stable across upgrades and is visible to every process, not just shells that ran `mise activate`. `brew bundle` moves each formula to the current release. That suits any tool where the newest version is the right version.

mise handles the case where the version has to vary by directory. It resolves the nearest `mise.toml` walking up from the working directory: a repo pinned to an older Go gets that toolchain, everything else follows the global pin in `conf.d/`. Language runtimes and project-pinned tools like `terraform` need that. A standalone CLI usually doesn't.

Declaring a tool in both places is fine and often useful. mise's activation prepends its install directories ahead of `$HOMEBREW_PREFIX/bin`. The mise version wins wherever a `mise.toml` selects one, and the Homebrew copy covers everywhere else.

### Dev Mode and Testing

Symlinks point at the installed copy in `~/.dotfiles`. Edits in a development clone don't take effect until synced. To test edits without syncing, the active root is resolved on every shell in [`zsh/active-root.zsh`](zsh/active-root.zsh), with this precedence:

```text
$DOTFILES_USE_DEV                  (throwaway test subshell)
  > ~/.dotfiles-dev-mode flag file (persistent dev mode)
    > $DOTFILES_HOME               (the installed copy)
```

Three commands drive it:

* `dotfiles test` replaces the current shell with one that loads the checkout, session-only.
* `dotfiles dev enable` persistently repoints every symlink to the checkout and sets the flag. `dotfiles dev disable` restores the installed copy.
* `dotfiles status` shows which root is active and its revision.

Writing the flag file and re-running `install-symlinks` happen in one step. It ends by [reloading](#config-reloads) the programs still holding the old root's config.

### Sync and Upgrade

A launchd agent ([`macos/com.user.dotfiles-upgrade.plist`](macos/com.user.dotfiles-upgrade.plist)) runs [`bin/dotfiles-upgrade`](bin/dotfiles-upgrade) nightly. It syncs from the remote, reruns `scripts/install`, and cleans up stale packages. On failure it files a Things task with the error.

`dotfiles sync` runs the same pull by hand. It refuses to sync a dirty tree, fast-forwards only, and updates submodules.

### Config Reloads

Most tools read their config once per invocation, so a sync is enough. A few hold it in memory for weeks: a herdr server, an open Ghostty. Those would sit on the config they started with until something restarted them.

A sync that moved the tree, an install, and a dev-mode toggle all end by calling [`bin/dotfiles-reload`](bin/dotfiles-reload). It runs every `<topic>/reload.sh`:

| Topic | Reload |
| --- | --- |
| [`herdr`](herdr/reload.sh) | `herdr server reload-config` over its socket API, for `config.toml` only |
| [`terminal`](terminal/reload.sh) | `SIGUSR2` to Ghostty, the same path as its `reload_config` action |

Every one is in place. The program re-reads its config and keeps its state, sessions, and child processes, and nothing restarts. This runs unattended at 3am, where a restart would take live work down with it. So a tool whose only path to new config is a restart gets no `reload.sh`, and picks the change up whenever it next starts.

Each script self-gates, exiting 0 without work when its tool isn't installed or isn't running, so a fresh machine and CI both do nothing. The dispatcher logs a failing script and carries on to the rest. It caps each at a minute, since a wedged socket would otherwise hang the nightly job past the point where it could report anything.

### Tests

Everything runs under `bun test`, shell scripts and TypeScript alike. A test sits next to what it covers and is named for it, so [`scripts/install-trust.test.ts`](scripts/install-trust.test.ts) covers `scripts/install-trust`. [`#harness`](packages/harness/index.ts) holds what a test driving a shell script needs: a sandbox to build a fake tree in, executable stubs that shadow a real command while their directory leads `$PATH`, and runners reporting a script's status alongside both its streams.

A test's name and where it sits decide where it runs. Most tests stub whatever the script under test calls and run on a bare checkout. The `*.integration.test.ts` files instead read the config this repo installed, through its symlinks, so [CI runs those](.github/workflows/test.yml) on Linux and macOS after bootstrap. [`git/config.integration.test.ts`](git/config.integration.test.ts) is one: it asks the installed global config what `pull.rebase` is set to.

### Bootstrap vs. Install

Two entry points split one-time setup from the repeatable reconcile step:

* [`scripts/bootstrap`](scripts/bootstrap) is the **one-time** fresh-machine path: install Homebrew, prompt for git identity, init submodules, then hand off to `dotf`, which runs install.
* [`scripts/install`](scripts/install) is the **idempotent** core, safe to rerun nightly: `brew bundle` → install mise runtimes → install symlinks → run each topic's `install.sh` → sync the theme → [reload](#config-reloads) whatever is running.

The nightly upgrade and the dev-mode relink both call `install`.

## Prior Art

* [holman](https://github.com/holman/dotfiles): Bootstrap/install scripts, initial ZSH config, colorization

## License

[MIT](license)
