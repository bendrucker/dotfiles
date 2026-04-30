---
name: screenshot-terminal
description: Capture screenshots of the user's tmux/terminal setup so the model can see what it actually looks like. Use when the user asks for a visual review of their terminal, tmux status bar, prompt, fonts, or pane chrome, or any case where text introspection (capture-pane, list-panes) loses styling, color, glyph, or layout fidelity.
---

# screenshot-terminal

This skill is for situations where seeing the rendered terminal matters more than reading its contents. tmux's status bar styling, Catppuccin pills, Nerd Font glyphs, powerline separators, pane chrome, and Ghostty's tab/title bar only render correctly in pixels; `tmux capture-pane` strips all of that.

## Modes

Pick a mode based on what the user is asking for:

- **peek-current** (default for review questions): read-only snapshot of the user's existing tmux session. No `send-keys`, no window switches that disturb the user. Capture the visible Ghostty window, dump structured tmux state (sessions/windows/panes/titles), and read both into context.
- **drive-current**: send keys to the user's session to set up a specific scene (open fzf, cycle a window, etc.) and capture. Confirm with the user before driving. `tmux/CLAUDE.md` is explicit that you should not send keys to a working pane just to demo.
- **fresh**: spawn a new detached tmux session, attach it in a new Ghostty window via `open -na Ghostty`, drive it programmatically, capture, and tear down. Use when reproducibility matters or the user's live session would be too noisy.

## Capture pipeline

All modes share the same primitives:

1. `scripts/list-terminal-windows [pattern]`: JXA enumerator over `CGWindowListCopyWindowInfo`. Returns JSON of `{ owner, id, name, bounds }` for Ghostty/iTerm/Terminal/Alacritty/WezTerm/Kitty windows, optionally filtered by a regex against the window name. No focus stealing.
2. `scripts/find-tmux-window [client-target]`: resolves the CGWindowID hosting the active tmux client. Walks the client's process tree to a terminal app PID; falls back to title scoring (`tmux` / `mosh` / session name) when the chain is broken (mosh, ssh, etc., reparent to PID 1 and break ancestor walking).
3. `scripts/capture-window <window-id> <out.png>`: wraps `screencapture -x -o -l <id>`. `-x` silences the shutter, `-o` omits window shadow.
4. `scripts/crop-png <src> <dst> <x> <y> <w> <h>`: crops via `NSBitmapImageRep`. The `sips` CLI fails under Claude Code's sandbox because it writes to a hardcoded `/var/folders` scratch path. Coordinates are in physical pixels (Retina is 2x point coords).
5. `scripts/tmux-snapshot [out-dir]`: dumps `sessions.tsv`, `windows.tsv`, `panes.tsv`, plus `pane-<id>.txt` per pane. Pairs with the screenshot so the rendered chrome and the textual contents are inspectable side-by-side.

## Gotchas

Always run `scripts/preflight` before capturing. It returns JSON with `ok: true` when capture is viable, or `ok: false` with a `reason` field. Exit codes: 0 ready, 2 locked, 3 no-terminals.

#### Screen lock blocks per-window and per-rect captures

When the screen is locked, Quartz shows `loginwindow` and the `Window Server`'s `Display Shield` topmost in `CGWindowListCopyWindowInfo`. `screencapture -l <id>` and `screencapture -R <rect>` both fail with `could not create image`. Fullscreen `screencapture -x` returns solid black. The only fix is asking the user to unlock. `scripts/preflight` detects this case.

#### Sandbox kills JXA in child scripts

The Claude Code sandbox segfaults JXA's access to AppKit/Quartz when `osascript -l JavaScript` runs from a child shell script, and blocks the tmux unix socket from scripts. Inline JXA (heredoc inside a Bash tool call) works fine. Helper scripts in `scripts/` must be invoked with `dangerouslyDisableSandbox: true` on the Bash call. The sandbox does not cover Write/Edit tool calls, so editing this skill is unaffected. The sandbox also blocks writes to `.claude/skills/` itself; pass the same flag when modifying skill files.

#### `sips` cannot crop under the sandbox

`sips --cropToHeightWidth` writes to a hardcoded `/var/folders` scratch directory the sandbox blocks (`Error 13: an unknown error occurred`). Setting `TMPDIR` does not help. Use `scripts/crop-png` instead, which writes via `NSBitmapImageRep` directly to the destination.

#### Screen Recording permission is on the calling app

`screencapture` requires Screen Recording permission for the *calling* terminal app (Ghostty, iTerm, etc.), not for `screencapture` itself. If captures come back as a uniform color but `scripts/preflight` passes, ask the user to grant Screen Recording in `System Settings → Privacy & Security → Screen Recording`. The terminal app must be relaunched after enabling.

#### JXA does not have `$.exit()`

When writing JXA helpers, do not call `$.exit(N)`; it is undefined and throws. Print JSON to stdout and let the parent shell script translate the result into an exit code (see `scripts/preflight` for the pattern).

#### Don't drive the user's working pane

Per `tmux/CLAUDE.md`: "Don't `send-keys` to their working pane to 'demonstrate'. That defeats the point." Use `fresh` mode for any scene the user shouldn't have to clean up.

#### Permissions JXA does not need

`osascript -l JavaScript` calls into `CGWindowListCopyWindowInfo` do *not* require Accessibility permission as long as enumeration stays read-only. Sending keys via `tmux send-keys` is just a local socket, so no Accessibility needed there either.

## Workflow: peek-current

Default flow when the user asks "what does my setup look like" or "review my status bar" or "why does X look weird":

```sh
mkdir -p tmp
.claude/skills/screenshot-terminal/scripts/tmux-snapshot tmp/snapshot
window_id=$(.claude/skills/screenshot-terminal/scripts/find-tmux-window)
.claude/skills/screenshot-terminal/scripts/capture-window "$window_id" tmp/snapshot/full.png
```

`find-tmux-window` is preferred over hand-rolled `jq` against `list-terminal-windows`. Terminal titles do not reliably contain the tmux session name (it depends on `set-titles-string`), and the process-tree walk handles the common case where you are SSHed or moshed into a host running tmux.

Then `Read` the PNG and the TSVs together. The TSVs let you map pane IDs visible in the chrome (`%27`, `%28`) back to current commands and pane titles.

For closer inspection of specific UI regions, status bar at top, prompt at bottom, or a single pane, crop with `scripts/crop-png`. Status bar on this user's setup is approximately the second row of pixels at `y=58, height=50` in a 3870px-wide image (1935 logical px times 2 Retina). Re-measure if the screenshot dimensions differ.

## Workflow: fresh

```sh
tmux new-session -d -s screenshot-skill -x 120 -y 30 'zsh -i'
open -na Ghostty --args -e tmux attach -t screenshot-skill
sleep 1   # wait for the new window to register in CGWindowListCopyWindowInfo
window_id=$(.claude/skills/screenshot-terminal/scripts/list-terminal-windows | jq -r '
  [.[] | select(.name | test("screenshot-skill"))] | .[0].id')
tmux send-keys -t screenshot-skill 'ls -la' Enter
sleep 0.3
.claude/skills/screenshot-terminal/scripts/capture-window "$window_id" tmp/fresh.png
tmux kill-session -t screenshot-skill
osascript -e 'tell application "Ghostty" to close (every window whose name contains "screenshot-skill")'
```

`open -na` forces a new app instance; Ghostty's `-e` flag runs a command in the new window. Adjust if the user's terminal is iTerm or Alacritty.

## What this skill does *not* do

- Render terminal output to images headlessly via `freeze` / `termshot` / `silicon`. Those are useful for ANSI-to-PNG but lose tmux chrome and depend on font config, so they don't help with the styling questions this skill exists for.
- Write reports. The skill produces images and TSVs in `tmp/`. Analysis goes back into the conversation, not into markdown files.
- Drive the user's working pane without confirmation. See `tmux/CLAUDE.md`.
