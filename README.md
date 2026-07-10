# dotfiles [![tests](https://github.com/bendrucker/dotfiles/actions/workflows/test.yml/badge.svg)](https://github.com/bendrucker/dotfiles/actions/workflows/test.yml)

> My dotfiles for configuring macOS

Linux friendly, outside of [`macos/`](macos/) and a [`Brewfile`](Brewfile) for dependency management. I use this repo for both home and work.

Highlights include:

* zsh with the minimal [pure](https://github.com/sindresorhus/pure) prompt
* Sub-second shell startup, [enforced by CI](#startup-performance-is-ci-gated)
* Sane defaults for programming languages I use

## Installing

```sh
git clone https://github.com/bendrucker/dotfiles.git ~/.dotfiles
cd ~/.dotfiles
scripts/bootstrap
```

## How it works

Everything is organized into **topic** directories: [`git/`](git/), [`zsh/`](zsh/), [`tmux/`](tmux/), and so on. A topic is just a directory that follows a few naming conventions. The bootstrap and startup scripts glob for those conventions across every topic, so adding a new tool means creating a directory and dropping in the right files. Nothing has to be registered in a central list.

### Topic conventions

A file's name determines how and when it loads. These are the conventions a topic can use:

| File | Purpose |
| --- | --- |
| `path.zsh` | Sourced first, from `.zshenv`, to set up `$PATH`. |
| `*.zsh` | Sourced at interactive shell startup. Aliases, functions, options. |
| `completion.zsh` | Sourced lazily after the first prompt renders (see [startup performance](#startup-performance-is-ci-gated)). |
| `symlinks.conf` | Declares config files to symlink into `$HOME` or `~/.config`. |
| `Brewfile` | Homebrew packages for the topic. |
| `mise.toml` | Pinned language/tool versions, merged into mise's config. |
| `install.sh` | Non-symlink setup: plugin managers, system config. Run by `scripts/install`. |
| `.shellspec` | Opts the topic into [integration tests](#topic-integration-tests) that run in CI. |
| `bin/` | Executables at the repo root, added to `$PATH`. |

The rest of this section documents the machinery behind those conventions.

### Shell startup

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

Completions are the expensive part of startup, so they don't run before the first prompt. `.zshrc` registers a one-shot `precmd` hook that sources every `completion.zsh` after the prompt is already interactive, then removes itself:

```zsh
_load_deferred_completions() {
  add-zsh-hook -d precmd _load_deferred_completions
  for file in $ZSH/**/completion.zsh; do source $file; done
}
add-zsh-hook precmd _load_deferred_completions
```

### Startup performance is CI-gated

Deferred completions only matter if regressions can't sneak back in, so [CI benchmarks startup](.github/workflows/test.yml) with [hyperfine](https://github.com/sharkdp/hyperfine) and **fails the build if median startup exceeds one second**:

```sh
hyperfine --warmup 3 --runs 10 --shell=none 'zsh -i -c exit'
# median > 1.0s → exit 1
```

The same job dumps a per-file [`zprof`](https://zsh.sourceforge.io/Doc/Release/Zsh-Modules.html#The-zsh_002fzprof-Module) self-time table into the run summary so regressions are easy to attribute. A few rules keep startup fast, documented in [`CLAUDE.md`](CLAUDE.md):

* **No subshell forks during startup.** Each `$(...)` costs ~15-50ms. `brew --prefix` is banned in favor of the already-exported `$HOMEBREW_PREFIX`.
* **`compinit -C`** skips the completion security audit on every startup. The full audit runs during the nightly upgrade instead.
* **Completions defer** via the `precmd` hook above. Because the deferral filter matches `completion.zsh` exactly, a file named `completions.zsh` (plural) would load eagerly and bypass it. CI [greps for that mistake](.github/workflows/test.yml) and fails.

`bin/bench-startup` measures the current worktree locally, or compares two worktrees head-to-head.

### Declarative symlinks

Config files are linked into place from per-topic [`symlinks.conf`](git/symlinks.conf) files in `source:target` format, one per line. Targets expand `~` and `$XDG_CONFIG_HOME`:

```
# git/symlinks.conf
config:$XDG_CONFIG_HOME/git/config
ignore:$XDG_CONFIG_HOME/git/ignore
```

[`scripts/install-symlinks`](scripts/install-symlinks) globs every `symlinks.conf`, creates the links, and validates each source exists. It also **prunes**: any symlink under `$HOME` or `~/.config` that points into the dotfiles repo but is no longer declared gets removed. Deleting a line from `symlinks.conf` is enough to clean up the stale link on the next install.

### Homebrew aggregation

The root [`Brewfile`](Brewfile) recursively evaluates every topic `Brewfile`, so `brew bundle` from the repo root installs everything:

```ruby
Dir.glob(File.join(File.dirname(__FILE__), '*', '**', 'Brewfile')) do |brewfile|
  eval(IO.read(brewfile), binding)
end
```

Passing `binding` means topic Brewfiles inherit the root's overridden `brew`/`cask`/`mas` methods, which layer on a couple of behaviors:

* **Duplicate detection.** `brew bundle` installs in parallel, so a package declared in two Brewfiles races on the Homebrew lock and aborts with a cryptic error. An `assert_unique_package` guard raises a clear error instead.
* **CI trims GUIs.** When `$CI` is set, `cask` and `mas` become no-ops so runners skip slow app installs.

A `~/Brewfile.local` is evaluated last, if present, for machine-specific packages that shouldn't live in the repo.

### Language versions with mise

Each language topic pins its versions in a `mise.toml` and links it into [mise](https://mise.jdx.dev/)'s drop-in config directory through its `symlinks.conf`, namespaced by topic:

```
# go/symlinks.conf
mise.toml:$XDG_CONFIG_HOME/mise/conf.d/go.toml
```

mise merges everything in `conf.d/` automatically, so each topic owns its own runtime versions without a shared config file. Versions are pinned exactly (never `latest`) so [Renovate](https://github.com/renovatebot/renovate) can track and bump them.

### Dev mode and testing

Symlinks point at the installed copy in `~/.dotfiles`, not a development checkout, so edits in a clone don't take effect until synced. To test changes immediately, the active root is a layer of indirection resolved on every shell in [`zsh/active-root.zsh`](zsh/active-root.zsh), with this precedence:

```
$DOTFILES_USE_DEV                  (throwaway test subshell)
  > ~/.dotfiles-dev-mode flag file (persistent dev mode)
    > $DOTFILES_HOME               (the installed copy)
```

Three commands drive it:

* `dotfiles test` starts a subshell that loads the current checkout, session-only.
* `dotfiles dev enable` persistently repoints every symlink to the checkout and sets the flag. `dotfiles dev disable` restores the installed copy.
* `dotfiles status` shows which root is active and its revision.

Writing the flag file and re-running `install-symlinks` happen in a single step, so the flag and the on-disk links can never disagree.

### Sync and upgrade

A launchd agent ([`macos/com.user.dotfiles-upgrade.plist`](macos/com.user.dotfiles-upgrade.plist)) runs [`bin/dotfiles-upgrade`](bin/dotfiles-upgrade) nightly. It syncs from the remote, reruns `scripts/install`, and cleans up stale packages. On failure it strips ANSI codes from the log and files a Things task with the error, so a broken upgrade surfaces as a to-do rather than silent drift.

`dotfiles sync` runs the same pull by hand. It refuses to sync a dirty tree, fast-forwards only, and updates submodules.

### Topic integration tests

Tests run against the real post-bootstrap state, not a mock. A topic opts in by containing a `.shellspec` file, and [CI discovers them](.github/workflows/test.yml) with a glob:

```bash
for spec in */.shellspec; do
  dir="${spec%/.shellspec}"
  (cd "$dir" && shellspec) || exit 1
done
```

Because the bootstrap job runs first, [these specs](git/spec/) verify the installed config through its symlinks, catching breakage that a static check would miss.

### Bootstrap vs. install

Two entry points split first-run setup from repeatable reconcile:

* [`scripts/bootstrap`](scripts/bootstrap) is the **one-time** fresh-machine path: install Homebrew, prompt for git identity, init submodules, then hand off to install.
* [`scripts/install`](scripts/install) is the **idempotent** core, safe to rerun nightly: `brew bundle` → install mise runtimes → install symlinks → run each topic's `install.sh` → sync the theme.

The nightly upgrade and the dev-mode relink both lean on `install`, which is why it has to stay safe to run repeatedly.

## Prior Art

* [holman](https://github.com/holman/dotfiles): Bootstrap/install scripts, initial ZSH config, colorization

## License

[MIT](license)
