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
- **Language versions**: Use `mise` configuration in `mise/` directory
- **Build packages**: Use `bin/build-default-packages` script

### Shell Configuration

- **Aliases**: Add to `<topic>/aliases.zsh`
- **Functions**: Add to `<topic>/functions.zsh` 
- **PATH modifications**: Add to `<topic>/path.zsh`
- **Completions**: Add to `<topic>/completion.zsh`

### Symlinked Dotfiles

- Name files with `.symlink` extension
- Bootstrap script creates `~/.filename` from `topic/filename.symlink`
- Special case: `ssh/config` is symlinked directly to `~/.ssh/config`

### Testing Changes

- Run `scripts/bootstrap` to apply symlinks
- Source shell: `source ~/.zshrc` or restart terminal
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

## Development Notes

- This is a personal configuration repo - changes should reflect actual usage
- macOS-specific items go in `macos/` directory
- Brew dependencies are managed per-topic for organization
- Shell integration follows ZSH plugin conventions