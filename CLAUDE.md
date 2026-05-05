# CLAUDE.md - Dotfiles Repository

This is a personal dotfiles repository for macOS with Linux compatibility. The repo uses a topic-based organization structure for shell configuration, tools, and application settings.

## Repository Structure

- **bin/**: Executable scripts added to `$PATH`
- **topic/**: Each topic is a directory (e.g., `git/`, `zsh/`, `docker/`)
  - `*.zsh`: Shell configuration files loaded by zsh
  - `path.zsh`: Loaded first for `$PATH` setup
  - `completion.zsh`: Deferred until after first prompt renders (via `precmd` hook)
  - `install.sh`: Topic installer for non-symlink setup (e.g., plugin managers, system config)
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
   - `<topic>/Brewfile` for dependencies
3. Run `scripts/install` to install links and run topic installers

### Managing Dependencies

- **Homebrew packages**: Add to topic-specific `Brewfile` or main `Brewfile`
- **Language versions**: Add `mise.toml` to the relevant topic directory (e.g., `go/mise.toml`)
- **Build packages**: Use `bin/build-default-packages` script

#### Brewfile Aggregation

The root `Brewfile` recursively loads all topic Brewfiles using:

```ruby
Dir.glob(File.join(File.dirname(__FILE__), '*', '**', 'Brewfile')) do |brewfile|
  eval(IO.read(brewfile), binding)
end
```

This means `brew bundle` from the repo root installs everything from all topic Brewfiles. The root Brewfile also conditionally skips casks/MAS in CI and some apps on corporate machines.

The root Brewfile additionally evaluates an untracked `Brewfile.local` (gitignored via `*.local`) when present. Use it for machine-specific packages (e.g. corporate-mandated tools) so they're managed by `brew bundle` without being flagged by `brew bundle cleanup`.

#### mise Aggregation

Topic directories can contain `mise.toml` files for language/tool versions. The `scripts/install` script auto-discovers these and symlinks them to `~/.config/mise/conf.d/`, where mise merges them alphabetically.

Always pin mise tool versions to exact values (e.g., `"0.9.6"`, not `"latest"`). Renovate tracks `mise.toml` files and auto-merges non-major updates after a 2-week release age delay. Using `"latest"` prevents Renovate from detecting new versions. For tools not available in the mise registry, use the `github:` backend (e.g., `"github:owner/repo" = "1.2.3"`) to install pre-built release binaries.

### Shell Configuration

- **Aliases**: Add to `<topic>/aliases.zsh`
- **Functions**: Add to `<topic>/functions.zsh`
- **PATH modifications**: Add to `<topic>/path.zsh`
- **Completions**: Add to `<topic>/completion.zsh`

### Config File Installation

Most tool configs live under `~/.config/<tool>/` (XDG Base Directory). Symlinks are declared in per-topic `symlinks.conf` files and installed by `scripts/install-symlinks`. Topics with non-symlink setup logic (plugin managers, system config) use `install.sh`.

- Symlinks point to `~/.dotfiles` (the installed copy), **not** the development working tree. Edits in a dev checkout won't take effect until synced unless dev mode is enabled.

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

## Sync and Upgrade System

### Automated Nightly Upgrades (macOS)

- `macos/com.user.dotfiles-upgrade.plist` runs `bin/dotfiles-upgrade` daily at 3am
- Syncs dotfiles, runs `scripts/install`, cleans up stale packages
- Creates a Things task on failure with error output

### Manual Commands

- `dotfiles sync` — Pull latest from remote
- `dotfiles sync --bootstrap` — Sync and re-run bootstrap for symlinks
- `dotf` — Full install/update: Homebrew, brew bundle, mise install, topic installers

### Installation Flow

`scripts/install` is the main entry point:
1. `brew bundle` — Install Brewfile dependencies
2. Symlink `*/mise.toml` → `~/.config/mise/conf.d/`
3. `mise install` — Install language runtimes
4. `scripts/install-symlinks` — Install declarative symlinks from `symlinks.conf`
5. Run topic `install.sh` scripts

## Stacked PRs

I use worktrunk for worktree creation and git-town for stack sync and PR management:

1. Create base branch: `wt switch --create feature/base`
2. Work, commit, then stack next branch: `wt switch --create child-name --base=@`
3. Sync entire stack: `git town sync --stack`
4. Propose all PRs: `git town propose --stack`

Ship branches oldest-first. After a stack branch merges, `git town sync` rebases remaining branches.

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
