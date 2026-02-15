# CLAUDE.md - Dotfiles Repository

This is a personal dotfiles repository for macOS with Linux compatibility. The repo uses a topic-based organization structure for shell configuration, tools, and application settings.

## Repository Structure

- **bin/**: Executable scripts added to `$PATH`
- **topic/**: Each topic is a directory (e.g., `git/`, `zsh/`, `docker/`)
  - `*.zsh`: Shell configuration files loaded by zsh
  - `path.zsh`: Loaded first for `$PATH` setup
  - `completion.zsh`: Loaded last for autocomplete
  - `*.symlink`: Files symlinked to `$HOME` as dotfiles
  - `Brewfile`: Homebrew packages for the topic
- **scripts/**: Bootstrap and setup scripts

## Common Tasks

### Adding a New Tool/Topic

1. Create directory: `mkdir <topic>/`
2. Add configuration files as needed:
   - `<topic>/<tool>.zsh` for shell configuration
   - `<topic>/<config>.symlink` for dotfiles that need symlinking
   - `<topic>/Brewfile` for dependencies
3. Run `scripts/bootstrap` to symlink new dotfiles

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

#### mise Aggregation

Topic directories can contain `mise.toml` files for language/tool versions. The `scripts/install` script auto-discovers these and symlinks them to `~/.config/mise/conf.d/`, where mise merges them alphabetically.

Always pin mise tool versions to exact values (e.g., `"0.9.6"`, not `"latest"`). Renovate tracks `mise.toml` files and auto-merges non-major updates after a 2-week release age delay. Using `"latest"` prevents Renovate from detecting new versions. For tools not available in the mise registry, use the `github:` backend (e.g., `"github:owner/repo" = "1.2.3"`) to install pre-built release binaries.

### Shell Configuration

- **Aliases**: Add to `<topic>/aliases.zsh`
- **Functions**: Add to `<topic>/functions.zsh` 
- **PATH modifications**: Add to `<topic>/path.zsh`
- **Completions**: Add to `<topic>/completion.zsh`

### Symlinked Dotfiles

- Name files with `.symlink` extension
- Bootstrap script creates `~/.filename` from `topic/filename.symlink`
- Special case: `ssh/config` is symlinked directly to `~/.ssh/config`
- Symlinks point to `~/.dotfiles` (the installed copy), **not** the development working tree. Edits to `.symlink` files in a dev checkout won't take effect until synced unless dev mode is enabled.

### Dev Mode

`dotfiles dev enable` repoints all home-directory symlinks from `~/.dotfiles` to the current working tree. This lets you test `.symlink` file changes (e.g., `tmux.conf.symlink`) immediately without syncing. Run `dotfiles dev disable` to restore symlinks to `~/.dotfiles`.

### Testing Changes

Both `.symlink` and `.zsh` files are loaded from `~/.dotfiles` by default. Edits in a dev checkout won't take effect without one of these approaches:

- **`dotfiles test`** — replaces the current shell with one using the dev working tree (temporary, session-only)
- **`dotfiles dev enable`** — persistently repoints all symlinks to the dev working tree and sets a flag so new shells load dev `.zsh` files. Undo with `dotfiles dev disable`.
- Run `scripts/bootstrap` to apply new symlinks
- Test dependencies: `bin/dotf` installs/updates packages

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
4. Run topic `install.sh` scripts

## Stacked PRs

I use worktrunk for worktree creation and git-town for stack sync and PR management:

1. Create base branch: `wt switch --create feature/base`
2. Work, commit, then stack next branch: `wt switch --create child-name --base=@`
3. Sync entire stack: `git town sync --stack`
4. Propose all PRs: `git town propose --stack`

Ship branches oldest-first. After a stack branch merges, `git town sync` rebases remaining branches.

## Development Notes

- This is a personal configuration repo - changes should reflect actual usage
- macOS-specific items go in `macos/` directory
- Brew dependencies are managed per-topic for organization
- Shell integration follows ZSH plugin conventions