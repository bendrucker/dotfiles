# Terminal

Shell and terminal emulator configuration.

## tmux

Minimal config focused on parallel worktree development with Claude Code, remote
access via mosh/Blink Shell, and sane copy/paste defaults.

### What it does

- **True color and hyperlinks** — programs inside tmux get full color and
  clickable OSC 8 links (in supported terminals like Ghostty)
- **System clipboard integration** — selections in tmux copy mode go straight to
  the system clipboard via OSC 52, including through mosh
- **Sensible numbering** — windows and panes start at 1, auto-renumber on close
- **Fast escape** — no half-second delay when pressing Escape in editors
- **URL-friendly word selection** — double-click selects entire URLs and ticket
  IDs instead of breaking on `/`, `-`, `.`

### Copy/paste

- **Mouse select in tmux** → automatically copies to system clipboard
- **Double-click** → selects whole URLs/identifiers
- **Option+click+drag** (Ghostty) → bypasses tmux, native terminal selection
- **Ctrl-b [** → enters copy mode for keyboard-driven selection

### Local overrides

Machine-specific settings go in `~/.tmux.conf.local`, which is sourced at the
end of the config.

## Ghostty

Theme configuration for the Ghostty terminal emulator. The config is symlinked
to `~/.config/ghostty/config` by `install.sh`.
