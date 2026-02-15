# Terminal

Shell and terminal emulator configuration.

## tmux

Minimal config focused on parallel worktree development with Claude Code, remote
access via mosh/Blink Shell, and sane copy/paste defaults.

### Features

- **True color and hyperlinks** — programs inside tmux get full color and
  clickable OSC 8 links (in supported terminals like Ghostty)
- **System clipboard integration** — selections in tmux copy mode go straight to
  the system clipboard via OSC 52, including through mosh
- **Sensible numbering** — windows and panes start at 1, auto-renumber on close
- **Fast escape** — no half-second delay when pressing Escape in editors
- **URL-friendly word selection** — double-click selects entire URLs and ticket
  IDs instead of breaking on `/`, `-`, `.`
- **Session switching** — `prefix + T` opens a fuzzy session picker powered by
  [sesh](https://github.com/joshmedeski/sesh) and fzf, with
  [zoxide](https://github.com/ajeetdsouza/zoxide) for frecency-ranked
  directories
- **Session persistence** —
  [tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) saves and
  restores sessions across tmux server restarts (`prefix + Ctrl-s` to save,
  `prefix + Ctrl-r` to restore)
- **Catppuccin theme** —
  [catppuccin/tmux](https://github.com/catppuccin/tmux) (mocha) for the status
  bar
- **Link opener** —
  [tmux-fzf-links](https://github.com/alberti42/tmux-fzf-links) extracts URLs
  from the terminal and opens them via fzf

### Plugins

Managed by [TPM](https://github.com/tmux-plugins/tpm). The install script
clones TPM and runs headless install/update/clean, so `dotf` keeps plugins
current automatically. To manage manually inside tmux:

| Binding | Action |
|---------|--------|
| `prefix + I` | Install new plugins |
| `prefix + U` | Update all plugins |
| `prefix + alt + u` | Remove unlisted plugins |

### Copy/paste

- **Mouse select in tmux** → automatically copies to system clipboard
- **Double-click** → selects whole URLs/identifiers
- **Option+click+drag** (Ghostty) → bypasses tmux, native terminal selection
- **prefix [** → enters copy mode for keyboard-driven selection

### Local overrides

Machine-specific settings go in `~/.tmux.conf.local`, which is sourced at the
end of the config (before TPM runs).

## Ghostty

Theme configuration for the Ghostty terminal emulator. The config is symlinked
to `~/.config/ghostty/config` by `install.sh`.
