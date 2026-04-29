---
name: gum
description: Add interactive prompts, spinners, styled logging, and pickers to shell scripts using gum. Use when editing a shell script and adding a prompt, asking for confirmation, wrapping a long-running command in a spinner, picking from a list, logging styled status output, or otherwise making a script interactive. Trigger on "add a prompt", "show progress", "spinner", "make this script interactive", "confirm before", "ask the user", "pick from a list", "menu", "styled logs", "gum log", "gum spin", "gum confirm", "gum choose", "gum input".
allowed-tools: [Read, Write, Edit, Grep, Glob]
---

# gum

[gum](https://github.com/charmbracelet/gum) is the house tool for shell-script UI in this repo. Use its native primitives directly. Do not wrap them in helper functions.

## House style

- Replace ad-hoc `info`/`warn`/`error`/`success`/`log`/`fail` helpers with inline `gum log --level info|warn|error` calls.
- Drop manual TTY detection (`[[ -t 1 ]]` plus ANSI variables). gum and lipgloss handle terminal capability detection.
- Drop `logger -t TAG` calls. There is no syslog consumer in this repo.
- Prefer one gum primitive per call site over a wrapper that hides which primitive runs.

## Logging

```sh
gum log --level info "syncing dotfiles"
gum log --level warn "fetch failed, retrying"
gum log --level error "could not pull"
```

There is no `success` level. Use `info` for completion messages.

## Spinners

Wrap commands whose output only matters when something goes wrong:

```sh
gum spin --show-output --show-error --title "brew bundle" -- brew bundle
```

`--show-output` keeps stdout on success, `--show-error` keeps it on failure. Both stay silent during the spin so the spinner reads cleanly. To capture output to a file, redirect the gum invocation, not the inner command:

```sh
gum spin --show-output --title "install" -- ./scripts/install > "$logfile"
```

For determinate progress (known total), use `gum progress` instead of `gum spin`. The README has the syntax.

## Confirm

`gum confirm` exits 1 on "no". Always use it as an `if` condition; don't rely on `set -e` to stop the script.

```sh
if gum confirm "Discard local changes?" --default=no; then
  git reset --hard HEAD
fi
```

## Input

```sh
name=$(gum input --header "GitHub author name" --placeholder "Jane Doe")
```

## Choose

Single-select:

```sh
choice=$(printf '%s\n' "${candidates[@]}" | gum choose --header "Pick one")
```

Multi-select with no item-count limit:

```sh
selected=$(printf '%s\n' "${candidates[@]}" | gum choose --no-limit --header "Remove which?")
```

## Format and table

Use `gum format --type markdown` for headers and bullet summaries, and `gum table --print` for tabular data:

```sh
gum format --type markdown <<EOF
# Report
- **Total:** $total
EOF

{ echo "Name,Count"; data_csv; } | gum table --print
```

## Reference

[gum README](https://github.com/charmbracelet/gum#readme) covers every command and its flags.
