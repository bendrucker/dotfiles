---
name: screenshot-terminal
description: Capture screenshots of the user's herdr/terminal setup so the model can see what it actually looks like. Use when the user asks for a visual review of their terminal, herdr sidebar, prompt, fonts, or pane chrome, or any case where text introspection (pane read, api snapshot) loses styling, color, glyph, or layout fidelity.
---

# screenshot-terminal

This skill is for situations where seeing the rendered terminal matters more than reading its contents. herdr's sidebar, Catppuccin theming, Nerd Font glyphs, agent state icons, pane chrome, and Ghostty's tab/title bar only render correctly in pixels. `herdr pane read` strips all of that.

## Modes

Pick a mode based on what the user is asking for:

- **peek-current** (default for review questions): read-only snapshot of the user's existing herdr session. No `send-keys`, no focus changes that disturb the user. Capture the visible Ghostty window, dump structured herdr state (workspaces/tabs/panes/agents), and read both into context.
- **drive-current**: send keys to the user's session to set up a specific scene (open a picker, switch a tab, etc.) and capture. Confirm with the user before driving. Never send keys to a working pane just to demo.
- **fresh**: spawn a scratch herdr workspace, drive it programmatically, capture, and tear down. Use when reproducibility matters or the user's live session would be too noisy.

## Capture pipeline

All modes share the same primitives:

1. `scripts/list-terminal-windows [pattern]`: JXA enumerator over `CGWindowListCopyWindowInfo`. Returns JSON of `{ owner, id, name, bounds }` for Ghostty/iTerm/Terminal/Alacritty/WezTerm/Kitty windows, optionally filtered by a regex against the window name. No focus stealing.
2. `scripts/find-herdr-window [workspace]`: resolves the CGWindowID hosting a herdr workspace, defaulting to the focused one. herdr's server reparents to PID 1, so ancestor walking from a pane never reaches the terminal app. Scores window titles against the workspace label and its panes' cwd basenames instead, and warns on stderr when nothing matched and it fell back to the frontmost window.
3. `scripts/capture-window <window-id> <out.png>`: wraps `screencapture -x -o -l <id>`. `-x` silences the shutter, `-o` omits window shadow.
4. `scripts/crop-png <src> <dst> <x> <y> <w> <h>`: crops via `NSBitmapImageRep`. The `sips` CLI fails under Claude Code's sandbox because it writes to a hardcoded `/var/folders` scratch path. Coordinates are in physical pixels (Retina is 2x point coords).
5. `scripts/herdr-snapshot [out-dir]`: dumps `snapshot.json` plus `workspaces.tsv`, `tabs.tsv`, `panes.tsv`, `agents.tsv`, and one buffer per pane at `panes/<pane-id>.txt` with the colon
   replaced by a dash, so pane `wC5:p1` lands at `panes/wC5-p1.txt`. Pairs with the screenshot so the rendered chrome and the textual contents are inspectable side-by-side.

## Gotchas

Always run `scripts/preflight` before capturing. It takes a real capture rather than inferring one is possible, so `ok: true` means an image came back with something in it. Exit codes: 0 ready, 2 locked, 3 no-terminals, 4 capture-failed, 5 capture-blank, 6 preflight itself could not run. Every exit prints one JSON line carrying `reason` and `screen_recording`, the grant the calling app holds. `screencapture_error` is on the `capture-failed` line alone, so read it only after `reason` says so.

When it reports `ok: false`, say so and switch channels rather than retrying. herdr's own chrome reads as text through a preview session: `herdr/bin/herdr-preview` runs a config in an isolated session inside a pane, and `herdr-preview read --ansi` returns the rendered sidebar with token colors intact as truecolor escapes. That works with the screen locked and with capture broken, which is most of what this skill was reached for.

#### Screen lock blocks per-window and per-rect captures

When the screen is locked, Quartz shows `loginwindow` and the `Window Server`'s `Display Shield` topmost in `CGWindowListCopyWindowInfo`. `screencapture -l <id>` and `screencapture -R <rect>` both fail with `could not create image`. Fullscreen `screencapture -x` returns solid black. The only fix is asking the user to unlock. `scripts/preflight` detects this case.

#### Sandbox kills JXA in child scripts

The Claude Code sandbox segfaults JXA's access to AppKit/Quartz when `osascript -l JavaScript` runs from a child shell script. Inline JXA (heredoc inside a Bash tool call) works fine. Helper scripts in `scripts/` must be invoked with `dangerouslyDisableSandbox: true` on the Bash call. The sandbox does not cover Write/Edit tool calls, so editing this skill is unaffected. The sandbox also blocks writes to `.claude/skills/` itself. Pass the same flag when modifying skill files.

#### `sips` cannot crop under the sandbox

`sips --cropToHeightWidth` writes to a hardcoded `/var/folders` scratch directory the sandbox blocks (`Error 13: an unknown error occurred`). Setting `TMPDIR` does not help. Use `scripts/crop-png` instead, which writes via `NSBitmapImageRep` directly to the destination.

#### Screen Recording permission is on the calling app

`screencapture` requires Screen Recording permission for the *calling* terminal app (Ghostty, iTerm, etc.), not for `screencapture` itself. A major macOS upgrade resets that grant, which leaves every window still enumerable and every capture failing with `could not create image from window`. `scripts/preflight` reports that as `capture-failed` with `screen_recording: false`. The fix is the user granting Screen Recording in `System Settings → Privacy & Security → Screen Recording`, then relaunching the terminal app. Nothing an agent can do from the shell restores it.

#### JXA does not have `$.exit()`

When writing JXA helpers, do not call `$.exit(N)`. It is undefined and throws. Print JSON to stdout and let the parent shell script translate the result into an exit code (see `scripts/preflight` for the pattern).

#### Don't drive the user's working pane

Sending keys to a pane the user is working in to demonstrate something defeats the point of the capture. Use `fresh` mode for any scene the user shouldn't have to clean up.

#### Permissions JXA does not need

`osascript -l JavaScript` calls into `CGWindowListCopyWindowInfo` do *not* require Accessibility permission as long as enumeration stays read-only. Sending keys via `herdr pane send-keys` goes over herdr's own socket, so no Accessibility needed there either.

## Workflow: peek-current

Default flow when the user asks "what does my setup look like" or "review my status bar" or "why does X look weird":

```sh
mkdir -p tmp
.claude/skills/screenshot-terminal/scripts/herdr-snapshot tmp/snapshot
window_id=$(.claude/skills/screenshot-terminal/scripts/find-herdr-window)
.claude/skills/screenshot-terminal/scripts/capture-window "$window_id" tmp/snapshot/full.png
```

`find-herdr-window` is preferred over hand-rolled `jq` against `list-terminal-windows`. It reads the workspace label and cwds out of `herdr api snapshot` rather than assuming the title format, and it tells you when it could not match rather than returning a confident wrong window.

Then `Read` the PNG and the TSVs together. The TSVs let you map pane IDs visible in the chrome (`wC5:p1`) back to cwds, titles, and the agent running in each.

For closer inspection of specific UI regions, status bar at top, prompt at bottom, or a single pane, crop with `scripts/crop-png`. Status bar on this user's setup is approximately the second row of pixels at `y=58, height=50` in a 3870px-wide image (1935 logical px times 2 Retina). Re-measure if the screenshot dimensions differ.

## Workflow: fresh

```sh
prev=$(herdr api snapshot | jq -r '.result.snapshot.focused_workspace_id')
ws=$(herdr workspace create --label screenshot-skill --cwd "$PWD" --focus | jq -r '.result.workspace.workspace_id')
pane=$(herdr api snapshot | jq -r --arg w "$ws" '
  .result.snapshot as $s
  | [$s.tabs[] | select(.workspace_id == $w) | .tab_id] as $tabs
  | [$s.panes[] | select(.tab_id as $t | $tabs | index($t)) | .pane_id] | .[0]')
herdr pane run "$pane" 'ls -la'
window_id=$(.claude/skills/screenshot-terminal/scripts/find-herdr-window "$ws")
.claude/skills/screenshot-terminal/scripts/capture-window "$window_id" tmp/fresh.png
herdr workspace close "$ws"
herdr workspace focus "$prev"
```

The workspace has to be focused for its window to be the one on screen, which is why `--focus` is passed. Capturing `$prev` first is what makes the last line able to put the user back where they were.

## What this skill does *not* do

- Render terminal output to images headlessly via `freeze` / `termshot` / `silicon`. Those are useful for ANSI-to-PNG but lose herdr's chrome and depend on font config, so they don't help with the styling questions this skill exists for.
- Write reports. The skill produces images and TSVs in `tmp/`. Analysis goes back into the conversation, not into markdown files.
- Drive the user's working pane without confirmation.
