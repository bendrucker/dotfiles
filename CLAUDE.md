# CLAUDE.md - Dotfiles Repository

This is a personal dotfiles repository for macOS with Linux compatibility. The repo uses a topic-based organization structure for shell configuration, tools, and application settings.

## Repository Structure

- **bin/**: Executable scripts added to `$PATH`
- **topic/**: Each topic is a directory (e.g., `git/`, `zsh/`, `docker/`)
  - `*.zsh`: Shell configuration files loaded by zsh
  - `path.zsh`: Loaded first for `$PATH` setup
  - `completion.zsh`: Deferred until after first prompt renders (via `precmd` hook)
  - `install.sh`: Topic installer for non-symlink setup (e.g., plugin managers, system config)
  - `reload.sh`: Tells an already-running program to re-read its config (see [Config Reloads](#config-reloads))
  - `Brewfile`: Homebrew packages for the topic
- **`*/symlinks.conf`**: Per-topic declarative symlink maps (`source:target`) discovered and processed by `scripts/install-symlinks`
- **scripts/**: Bootstrap and setup scripts

## Common Tasks

### Adding a New Tool/Topic

1. Create directory: `mkdir <topic>/`
2. Add configuration files as needed:
   - `<topic>/<tool>.zsh` for shell configuration
   - Add a `symlinks.conf` in the topic directory for config files targeting `~/.config/<tool>/`
   - `<topic>/install.sh` only if non-symlink setup is needed (plugin managers, system config)
   - `<topic>/reload.sh` only if the tool holds its config in memory and can re-read it without restarting (see [Config Reloads](#config-reloads))
   - `<topic>/Brewfile` for dependencies
3. Run `scripts/install` to install links and run topic installers

A topic is a subject, not a package. Most new tools do not earn a directory. A tool that amounts to a Brewfile line and a few aliases goes in a file inside an existing topic, named for what it does: `system/ls.zsh` holds the eza aliases, `system/networking.zsh` the dns and ip ones. Use `system/` when nothing more specific fits.

Give a tool its own directory when it has something to put there: config files to symlink, an installer, a `mise.toml`, a spec, or enough shell config that one file stops describing it. Directories are the unit someone scans to learn what this repo manages, so a wall of single-alias topics costs more than it explains.

### Managing Dependencies

- **Homebrew packages**: Add to topic-specific `Brewfile` or main `Brewfile`
- **Language versions**: Add `mise.toml` to the relevant topic directory (e.g., `go/mise.toml`)
- **Build packages**: Use `bin/build-default-packages` script

Homebrew is the default for a new tool. It links into `$HOMEBREW_PREFIX/bin`, a path that survives upgrades and is visible to every process rather than only shells that ran `mise activate`, and `brew bundle` tracks the current release. Use `mise.toml` when the version has to vary by directory, which is what mise resolves per-project: language runtimes and project-pinned tools like `terraform`. Declaring a tool in both is fine. mise's install directories come first on `$PATH`. A mise pin wins where one applies and the Homebrew copy covers everywhere else.

#### Brewfile Aggregation

The root `Brewfile` recursively loads all topic Brewfiles using:

```ruby
Dir.glob(File.join(File.dirname(__FILE__), '*', '**', 'Brewfile')) do |brewfile|
  eval(IO.read(brewfile), binding)
end
```

This means `brew bundle` from the repo root installs everything from all topic Brewfiles. The root Brewfile also conditionally skips casks/MAS in CI and some apps on corporate machines.

The root Brewfile additionally evaluates `~/Brewfile.local` when present. Use it for machine-specific packages (e.g. corporate-mandated tools) so they're managed by `brew bundle` without being flagged by `brew bundle cleanup`. See [Machine-Local Configuration](#machine-local-configuration) for the other `.local` include points.

#### mise Aggregation

Topic directories can contain `mise.toml` files for language/tool versions. The `scripts/install` script auto-discovers these and symlinks them to `~/.config/mise/conf.d/`, where mise merges them alphabetically.

Always pin mise tool versions to exact values (e.g., `"0.9.6"`, not `"latest"`). Renovate tracks `mise.toml` files and auto-merges non-major updates after a 2-week release age delay. Using `"latest"` prevents Renovate from detecting new versions. For tools not available in the mise registry, use the `github:` backend (e.g., `"github:owner/repo" = "1.2.3"`) to install pre-built release binaries.

#### Neovim Plugins

Plugins are declared in `neovim/config/init.lua` with `vim.pack.add` and no `version`, so each tracks its default branch. The pin lives in `neovim/config/nvim-pack-lock.json`. That lockfile is authoritative when present, and `vim.pack` takes every revision from it while ignoring `version`. This is what lets a fresh machine reproduce an existing one.

Updates are manual. Run `:lua vim.pack.update()`, review the confirmation buffer, `:write` to apply, then commit the lockfile diff. Renovate is not a fallback here, because nvim-treesitter publishes no tags on `main` (its tags sit on the diverged `master` branch) and lualine and vim-tmux-navigator publish no version tags at all.

Treesitter parsers are built against a specific nvim-treesitter revision. They break when the plugin moves ahead of them. A `PackChanged` autocommand in `neovim/config/lua/config/treesitter.lua` re-runs `treesitter.update()` on every plugin change, and `neovim/spec/` asserts that each declared language ends up with a parser that attaches a highlighter.

### Shell Configuration

- **Aliases**: Add to `<topic>/aliases.zsh`
- **Functions**: Add to `<topic>/functions.zsh`
- **PATH modifications**: Add to `<topic>/path.zsh`
- **Completions**: Add to `<topic>/completion.zsh`

### Config File Installation

Most tool configs live under `~/.config/<tool>/` (XDG Base Directory). Symlinks are declared in per-topic `symlinks.conf` files and installed by `scripts/install-symlinks`. Topics with non-symlink setup logic (plugin managers, system config) use `install.sh`.

- Symlinks point to `~/.dotfiles` (the installed copy), **not** the development working tree. Edits in a dev checkout won't take effect until synced unless dev mode is enabled.
- A `source` may be a directory, linking the whole tree in one entry. This is what to use when a tool owns a directory of same-shaped files and you want a new file to go live without another install run. The catch is a tool that writes its own state in there, which lands in the repo too. A `.gitignore` inside the tree narrows what gets tracked. `herdr/plugins/config` mirrors `$XDG_CONFIG_HOME/herdr/plugins/config`, tracks each plugin's `config.toml`, and ignores the rest.
- A real directory sitting at a link target aborts the install with the path named. Move its contents into the repo, remove it, re-run.

### Dev Mode

`dotfiles dev enable` repoints all symlinks (both `$HOME` and `~/.config/`) from `~/.dotfiles` to the current working tree. This lets you test config changes immediately without syncing. Run `dotfiles dev disable` to restore symlinks to `~/.dotfiles`.

### Testing Changes

Config and `.zsh` files are loaded from `~/.dotfiles` by default. Edits in a dev checkout won't take effect without one of these approaches:

- **`dotfiles test`** — replaces the current shell with one using the dev working tree (temporary, session-only)
- **`dotfiles dev enable`** — persistently repoints all symlinks (home and XDG) to the dev working tree and sets a flag so new shells load dev `.zsh` files. Undo with `dotfiles dev disable`.
- **Source directly from the worktree** — for configs like tmux that support runtime reload, source the worktree file explicitly (e.g., `tmux source-file /path/to/worktree/tmux/tmux.conf`). Do **not** suggest `prefix+r` or `tmux source-file ~/.config/tmux/tmux.conf` — those follow the symlink to `~/.dotfiles`, not the worktree.
- Test dependencies: `bin/dotf` installs/updates packages

### Topic Integration Tests

Topics can ship a shellspec integration test that runs in CI after bootstrap (so symlinks are installed and packages are available). The bootstrap job iterates `*/.shellspec` and runs `shellspec` in each matching directory.

To add tests to a topic:

1. Create `<topic>/.shellspec` with shellspec options (e.g., `--shell bash`)
2. Create `<topic>/spec/<name>_spec.sh` with `Describe`/`It` blocks

Existing examples: `git/spec/`, `neovim/spec/`. Tests run against the installed config (symlinks from `~/.dotfiles`), so they verify the real post-bootstrap state.

#### Stubbing a Command for a zsh Script

A spec that runs a script from `bin/` and replaces one of its dependencies with a stub has to isolate zsh's startup files. Those scripts use a `#!/usr/bin/env zsh` shebang, and zsh sources `~/.zshenv` on every invocation, non-interactive ones included. `zsh/.zshenv` runs `brew shellenv`, which can put `$HOMEBREW_PREFIX/bin` ahead of whatever the spec prepended to `$PATH`, so the real command wins and the stub never runs. Point `ZDOTDIR` at an empty directory for the duration of the call. zsh then finds no `.zshenv` and leaves `$PATH` alone.

```sh
run_with_stub() {
  (cd "$dir" && PATH="$stub_bin:$PATH" ZDOTDIR="$empty_dir" "$script" "$@")
}
```

The shape of this failure is what makes it worth documenting. It passes on a developer machine, where `HOMEBREW_PREFIX` is already exported and `brew shellenv` emits no `PATH` line, and fails in CI, where it does. Prepending to `$PATH` is enough to stub a command for a bash script, so the habit carries over and breaks silently.

### Version Updates

Recent patterns show dependency updates via PRs:
- Update `mise` tool versions in `mise/` directory
- Update Homebrew dependencies in `Brewfile`
- Use commit format: `chore(deps): update dependency <tool> to v<version>`

### Common Commit Patterns

Based on recent history:
- `chore(deps): update dependency <tool> to v<version>` - dependency updates
- `<topic>: <description>` - topic-specific changes (e.g., `mise: add Python 3.12`)
- `fix: <description>` - bug fixes
- `rm <tool>` - removing tools/configurations

### Maintenance

- Keep `Brewfile.lock.json` updated when modifying `Brewfile`
- Test bootstrap script after major changes
- Ensure Linux compatibility outside of `macos/` directory
- Use GitHub Actions for automated testing

## Machine-Local Configuration

This repo is public and installs identically on every machine. Anything specific to one machine or to an employer lives in an untracked `.local` file that the tracked config includes, and nothing in the repo reveals what those files contain. They exist. Assume a tool that shows up heavily in shell history with no topic directory is declared in one of them.

| Include point | Loaded by | What lives there |
| --- | --- | --- |
| `~/.zshenv.local` | `zsh/.zshenv`, last line | Env vars and `$PATH` entries every shell needs, including non-interactive |
| `~/.localrc`, `~/.zshrc.local` | `zsh/.zshrc`, before topic files | Interactive-only shell config |
| `~/Brewfile.local` | root `Brewfile`, last line | Employer-mandated and machine-specific packages |
| `~/.config/git/config.local` | `git/config` `[include]` | Identity, credential helper, per-org `includeIf` identities. Template in `git/config.local.example` |
| `~/.ssh/config.local` | `ssh/config` `Include` | Work hosts, jump hosts, the Secretive `Host *` fallback |
| `~/.config/tmux/tmux.conf.local` | `tmux/tmux.conf` `source-file -q` | Per-machine tmux overrides |

The two zsh hooks load at opposite ends. `~/.zshenv.local` comes after every `path.zsh` and can override `$PATH`. `~/.localrc` and `~/.zshrc.local` come before the topic `.zsh` files, so a topic file wins over anything they set.

Expect work tooling to be absent here: corporate cloud and SSO clients, internal CLIs, VPN clients, org-specific credential helpers. `brew bundle` evaluates `~/Brewfile.local`, so those packages install and upgrade normally and `brew bundle cleanup` leaves them alone.

Never add employer-specific tooling to a topic directory. Machines legitimately differ in what they have on `$PATH`. Before proposing a new topic for something seen in shell history, ask whether it belongs in `~/Brewfile.local` instead.

## Sync and Upgrade System

### Automated Nightly Upgrades (macOS)

- `macos/com.user.dotfiles-upgrade.plist` runs `bin/dotfiles-upgrade` daily at 3am
- Syncs dotfiles, runs `scripts/install`, runs `brew cleanup`, reports undeclared packages
- Creates a Things task on failure with error output

### Package Drift

`scripts/brew-drift` prints the Brewfile entries that would declare whatever is installed and declared nowhere. The nightly job runs it after `brew cleanup`, and `report_drift` in `bin/dotfiles-upgrade` files a Things to-do naming what it found. Silence means the machine matches the Brewfile.

Nothing uninstalls. A package no Brewfile names is either a leftover or something installed deliberately an hour ago that has not been written down yet. At 3am those are the same thing. Removing on that ambiguity loses work no one asked to lose, so the removal stays a decision made awake. Act on a to-do by declaring the package in a topic Brewfile or uninstalling it by hand.

Omitting `--force` does not make `brew bundle cleanup` a dry run. It prints the listing, then asks whether to uninstall, and `--force` only skips the question. `scripts/brew-drift` closes stdin, so the prompt cannot be shown and the command exits 1 with the listing already printed and nothing removed. That is what stops a hand run from uninstalling anything.

`brew bundle cleanup` therefore exits nonzero whenever it printed a listing it could not act on, which is the normal result of a run that found something. `scripts/brew-drift` treats the listing as the signal and the status as decisive only when there is no output at all to read, so it exits 0 on a finding and 1 only when cleanup produced nothing. That is what lets `bin/dotfiles-upgrade` tell a finding apart from a check that could not run.

`brew bundle cleanup` is what decides "undeclared", so the answer accounts for what a hand-rolled comparison gets wrong. `brew list --cask` is the trap: it enumerates the compatibility symlinks Homebrew leaves behind when a cask is renamed, so `docker`, `google-cloud-sdk`, `logi-options-plus`, and `tailscale` all read as installed-but-undeclared while being nothing of the kind. Uninstalling one resolves the alias and takes out the cask that replaced it. Bundle cleanup also spares a formula kept alive as another package's dependency, and anything declared in `~/Brewfile.local`.

It reports the four kinds this repo's Brewfiles declare: formulae, casks, taps, and Mac App Store apps. Homebrew cleans up VS Code extensions and npm globals under the same output shape. Naming the headers rather than matching the shape keeps a package manager this repo adopts later from turning the nightly report into an extension audit. The cost is that a renamed header upstream silences that kind rather than breaking the run, because an empty parse is also what a clean machine produces.

The to-do latch keys on the sorted package set rather than on the fact of a finding. A to-do left unactioned stays quiet while the same packages are undeclared. A newly installed one reopens it under its own to-do. Sorting matters because Homebrew orders the listing by a dependency sort taken over every installed package, so installing something unrelated and declared can reshuffle the undeclared names without changing the set.

A failing drift check is contained the way a failing `reload.sh` is. The install it follows has already succeeded, and a package that is merely undeclared breaks nothing overnight.

### GitHub Transport

The nightly jobs run at 3am against a locked Mac, where Secretive refuses to sign and any SSH fetch dies on `agent refused operation`. Every repo these jobs sync is public, so `git_sync` calls `git_https_remote` to move a `github.com` origin to anonymous HTTPS before fetching. Only the fetch URL moves, because the SSH URL stays behind as the remote's `pushurl` and pushes keep the credentials they already had. The rewrite is persistent and idempotent. A clone that arrives over SSH heals on its next sync.

`claude-upgrade` also calls `git_https_env`, which exports the same rewrite as an `insteadOf` rule. That covers the marketplace and plugin clones Claude Code makes for itself, which it creates with `git@github.com:` URLs and re-clones on every update. An `insteadOf` rule outranks a `pushurl`, so the exports are scoped to the plugin steps rather than the whole script.

Storing an HTTPS URL does not settle which transport the fetch uses. An org that standardizes on SSH installs a `url.<base>.insteadOf` rule mapping `https://github.com/` back to `git@github.com:`, and that rule rewrites whatever is stored. Nothing written to the remote escapes it. `git_https_pin` covers that. Git applies the longest matching rule, so one keyed on the remote's full HTTPS URL and mapping it to itself outranks any broader `github.com` rule. It goes in the repo's own config and names a single URL, so every other remote is left alone. The pin is written only when git resolves the remote to one of the github SSH forms, and that SSH URL stays behind as the `pushurl`. SSH is the whole point, since it is the transport that cannot sign while the Mac is locked. A rule routing the remote to another HTTPS host is a mirror or a proxy that someone chose and that may be the only route out, so it is left in place. A rule of equal length registered earlier still wins the tie. The pin is written once and logs where the remote resolves instead, so the run that cannot win leaves the config no larger.

Only the stored URL decides whether a remote is a github remote. A rule can send some other host to github, but one that rewrites the host without keeping the repo path would have us store a URL naming a repository that does not exist, so `git_https_remote` acts on what `.git/config` holds and nothing else.

`git config --get remote.<name>.url` gives the stored URL, which is what a rewrite keys on. Never read that with `git remote get-url`: it resolves `insteadOf` rules, so it reports HTTPS while `.git/config` still holds the SSH URL, and a rewrite keyed on it silently never fires. `git ls-remote --get-url` gives the URL the fetch will actually open, which is how the pin tells whether it took.

### Manual Commands

- `dotfiles sync` — Pull latest from remote
- `dotfiles sync --bootstrap` — Sync and re-run bootstrap for symlinks
- `dotf` — Full install/update: Homebrew, brew bundle, mise install, topic installers
- `scripts/brew-drift`: Print the Brewfile entries that would declare whatever is installed and undeclared

### Installation Flow

`scripts/install` is the main entry point:
1. `brew bundle` — Install Brewfile dependencies
2. Symlink `*/mise.toml` → `~/.config/mise/conf.d/`
3. `mise install` — Install language runtimes
4. `scripts/install-symlinks` — Install declarative symlinks from `symlinks.conf`
5. Run topic `install.sh` scripts
6. Run `theme/bin/theme-sync` to reconcile theme-managed configs to the active flavor
7. Run `bin/dotfiles-reload` to hand the new config to whatever is already running

### Config Reloads

`bin/dotfiles-reload` runs every `<topic>/reload.sh`, so a config change reaches a program that has been running for weeks instead of waiting for a restart. `scripts/install` and `dotfiles dev enable|disable` call it directly. `bin/dotfiles-sync` calls it only when the pull moved the tree, and its `--bootstrap` path reaches it through `scripts/install` instead. `herdr/`, `tmux/`, and `terminal/` are the topics that have one.

Every reload is in place. The program re-reads its config and keeps its state, sessions, and child processes. Nothing here may restart a server, kill a session, or drop in-flight work. This runs unattended from the 3am job, where a restart takes live work down with it, so a tool whose only path to new config is a restart gets no `reload.sh` and picks the change up on its next start.

A `reload.sh` self-gates. Exit 0 without work when the tool isn't installed or isn't running, since a fresh machine and CI hit both cases. Assume roughly a minute of runtime: the dispatcher caps each script there so a wedged peer can't hang the nightly job.

A failing `reload.sh` is contained on purpose. The dispatcher logs it and carries on to the rest, and both callers downgrade its exit status to a warning, so a broken reload never fails an install or the nightly job. Leave that alone. The install it follows has already succeeded, and stale in-memory config resolves itself the next time the program starts.

Re-sourcing `tmux.conf` runs `theme-sync-tmux` near the end, so a tmux reload and a theme flip collide. Both take the lock in `scripts/lib/tmux-source-lock.sh`, and `tmux/reload.sh` additionally publishes its pid in `@tmux_config_reloading` so the nested run stands down rather than waiting out the lock timeout and stealing a lock still in use. Route any new re-source trigger through one of those two scripts.

## Stacked PRs

Each branch in a stack lives in its own worktrunk worktree. `wt sync` owns the local side and rebases each branch onto its parent in dependency order.

1. Create base branch: `wt switch --create feature/base`
2. Work, commit, then stack next branch: `wt switch --create child-name --base=@`
3. Sync entire stack: `wt sync --push`

Publishing to GitHub runs in three steps. Start with `wt sync --push`, because `gh stack link` pushes without force and would be rejected on a freshly rebased branch. Then open each layer's PR with `/ship` or `pull-request:create`. That gets it a real body and the review passes. Then `gh stack link <bottom> ... <top>` chains the bases and registers the stack on GitHub. `link` opens a PR for any branch still missing one, with an auto-generated title and body, so let it fill gaps rather than lead. It writes no local tracking state, which is why it fits the one-worktree-per-branch layout.

`gh stack merge` lands the stack. With no argument it merges everything atomically. Pass a PR number to stop partway, and GitHub retargets and rebases the layers left open. `gh pr merge` does not work on a stacked PR. The `ghm` alias is off limits once a stack exists. Follow a merge with `wt sync --prune` to drop integrated worktrees.

`link` and `merge` are the only two `gh stack` commands to use here. Everything else (`init`, `add`, `submit`, `push`, `checkout`, `sync`, `rebase`, `modify`, `unstack`, `view`, and the `up`/`down`/`top`/`bottom`/`switch`/`trunk` navigation) reads or writes local tracking state that assumes every layer is checked out in one working tree. `submit` is the trap, since it is the command the tool's own help steers you toward. `gh stack rebase` reports success for a branch checked out in another worktree without doing anything ([gh-stack#35](https://github.com/github/gh-stack/issues/35)).

On GitLab, `glab stack` fills the same role. See the `gitlab:merge-request` skill.

## ZSH Startup Performance

Shell startup time is CI-gated (<1s). Follow these rules to avoid regressions:

- **Never call `brew --prefix`** in `.zsh` files — use `$HOMEBREW_PREFIX` (already exported by `brew shellenv` in `zshenv`)
- **Never call `$(command ...)` or `` `command` `` during startup** unless guarded — subshell forks are ~15-50ms each
- **All completions are deferred** — `completion.zsh` files are sourced via a one-shot `precmd` hook after the first prompt, not during startup. Put completion registrations (e.g., `eval "$(tool completion)"`, `compdef`) in `completion.zsh`, never in regular `.zsh` files.
- **Use `compinit -C`** — skips the security audit on every startup (directory permission check). The full audit runs during `dotfiles-upgrade`.
- **`path.zsh` is sourced only in `zshenv`** — do not re-source path files in `zshrc`
- **File naming matters** — the zshrc filter matches `completion.zsh` (singular). Files named `completions.zsh` (plural) will be sourced eagerly in the main loop, bypassing deferral. CI enforces this via `lint-completion-names`.
- **Defer everything interactive** — anything not needed before the first prompt (completions, key bindings that shell out, etc.) should run in the `precmd` deferred hook, not during startup
- **Benchmarking**: `bench-startup` measures the current worktree; `bench-startup /path/to/other` compares two worktrees. Uses `ZDOTDIR` + `DOTFILES_USE_DEV` to isolate each worktree's rc files without modifying symlinks. Use `ZPROF=1 zsh -i -c exit` for per-file breakdown.

## Development Notes

- This is a personal configuration repo - changes should reflect actual usage
- macOS-specific items go in `macos/` directory
- Brew dependencies are managed per-topic for organization
- Shell integration follows ZSH plugin conventions
