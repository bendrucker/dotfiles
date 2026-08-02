# Terminal

Shell and terminal emulator configuration.

## tmux

Minimal config focused on parallel worktree development with Claude Code, remote
access via mosh/Blink Shell, and sane copy/paste defaults.

### Features

- **True color and hyperlinks:** programs inside tmux get full color and
  clickable OSC 8 links (in supported terminals like Ghostty)
- **System clipboard integration:** selections in tmux copy mode go straight to
  the system clipboard via OSC 52, including through mosh
- **Sensible numbering:** windows and panes start at 1, auto-renumber on close
- **Fast escape:** no half-second delay when pressing Escape in editors
- **URL-friendly word selection:** double-click selects entire URLs and ticket
  IDs instead of breaking on `/`, `-`, `.`
- **Session switching:** `prefix + T` opens
  [tmux-fzf](https://github.com/sainnhe/tmux-fzf), a fuzzy picker for sessions,
  windows, panes, and more
- **Session persistence:**
  [tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) saves and
  restores sessions across tmux server restarts (`prefix + S` to save,
  `prefix + Ctrl-r` to restore), including
  [letting a pane resume its own session](#resuming-sessions)
- **Catppuccin theme:**
  [catppuccin/tmux](https://github.com/catppuccin/tmux) (mocha) for the status
  bar
- **Link opener:**
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

### Resuming sessions

A pane can resume its own session on restore instead of starting fresh. The
mechanism is one pane-scoped tmux option, `@resume-command`: a pane sets it to
the command that restores its session, and the `@resurrect-hook-post-save-all`
hook (`tmux/session/bin/tmux-resurrect-resume`) swaps that command into the
pane's saved restore command before the save file is finalized. A pane that
never set the option restores fresh.

This stays program-agnostic: the restore command comes entirely from the pane,
so the config holds no per-program logic. The one exception is
`@resurrect-processes` in `session.conf`: resurrect re-runs a restored command
only if it matches that allowlist, so each binary is listed there (`~claude`).

A session id (the runtime state that makes resume possible) is lost by restore
time, so resurrect's built-in strategies, which see only the saved command and
directory, cannot recover it. Capturing it as a pane option at save time is what
closes that gap.

#### Setting the option

A program sets `@resume-command` from a hook that fires on session start. For
Claude Code, a `SessionStart` hook (matching the `startup` and `resume` sources,
so it stays current across resumes) does it in one line, since
`$CLAUDE_CODE_SESSION_ID` and `$TMUX_PANE` are already in the environment:

```sh
[ -n "$TMUX_PANE" ] && tmux set-option -p -t "$TMUX_PANE" @resume-command "claude --resume $CLAUDE_CODE_SESSION_ID"
```

The `$TMUX_PANE` guard makes it a no-op outside tmux. The only contract between
a program and tmux is the option name; either side can change independently.

### Copy/paste

- **Mouse select in tmux** → automatically copies to system clipboard
- **Double-click** → selects whole URLs/identifiers
- **Option+click+drag** (Ghostty) → bypasses tmux, native terminal selection
- **prefix [** → enters copy mode for keyboard-driven selection

### Local overrides

Machine-specific settings go in `~/.config/tmux/tmux.conf.local`, which is sourced
at the end of the config (before TPM runs).

## Ghostty

Theme configuration for the Ghostty terminal emulator. The config is symlinked
to `~/.config/ghostty/config` by `install.sh`.

## Fonts

Ghostty renders `MonaspiceNe NFM`, installed by `font-monaspice-nerd-font@tip`
from the [`bendrucker/fonts`](https://github.com/bendrucker/homebrew-fonts) tap.
That tap patches Monaspace from nerd-fonts `master` instead of a release,
because 3.4.0 shipped in April 2025, predates the Codicon brand marks for
Claude, OpenAI, and Cursor, and is still the newest release. The family name
matches upstream's cask, so swapping back to `font-monaspice-nerd-font` when
3.5.0 lands changes nothing else.

### Client Coverage

tmux and herdr emit bytes. The attached *client* picks the font. One session can
be attached from Ghostty on the Mac and Rootshell on an iPad at the same time,
so a glyph cannot be varied per client. The usable set is the intersection of
every client's coverage. That is why the font goes onto every client, rather
than holding the glyphs back to what a stock release covers.

Rootshell and Moshi both import a TTF/OTF. Open the tap's latest release on the
device and import the four `.otf` assets. They are uploaded individually so a
single file can be tapped from Safari without unzipping. Release notes list the
codepoints each build gained, so a re-import only matters when one of them turns
up in `glyphs.conf`.

### `glyphs.conf`

`glyphs.conf` declares every private-use glyph this repo renders, with the Nerd
Fonts name it comes from. `glyph-scan` fails when a tracked file uses a glyph
that is not declared, and `glyph-scan --font` fails when the installed font is
missing one that is. CI runs the first. `spec/glyphs_spec.sh` runs both, skipping
the second where the cask was not installed.
