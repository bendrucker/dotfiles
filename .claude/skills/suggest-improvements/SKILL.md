---
name: suggest-improvements
description: Analyze shell history and installed tools to suggest dotfiles improvements. Use when looking for missing aliases, functions, completions, or topics based on actual usage patterns. Trigger on "what aliases should I add", "what's missing from my dotfiles", "audit my shell setup", "suggest improvements", "what should I add to my dotfiles", or any request to review dotfiles for gaps.
allowed-tools: [Read, Bash, Grep, Glob, Agent]
---

# Suggest Improvements

Analyze shell history and installed tools to surface dotfiles improvements. This skill only suggests — it never modifies files.

## Gather Dotfiles Inventory

Inventory what the dotfiles already provide:

- **Aliases**: `Grep` for `^alias ` across `*/aliases.zsh` and `*/*.zsh`
- **Functions**: `Grep` for function definitions across `*/*.zsh`
- **Completions**: `Glob` for `*/completion.zsh`, plus list Homebrew-provided completions via `ls $HOMEBREW_PREFIX/share/zsh/site-functions/_*`
- **Topics**: list topic directories (top-level dirs excluding `.git`, `.github`, `.claude`, `scripts`, `bin`, `tmp`)
- **Brew packages**: `Grep` for `^brew ` across `*/Brewfile`
- **bin/ scripts**: list `bin/`

Run all of these in parallel.

## Pre-process History

Run Bash commands to produce compact frequency tables from `~/.zsh_history`. All `awk`/`sed` commands that parse history must include an inline comment documenting the input format they handle.

History spans a long time, so raw counts can be misleading — a command used heavily years ago but not recently is not a good alias candidate. Split analysis into **recent** (last 6 months) and **all-time** to distinguish active patterns from stale ones.

**History date range:**

```bash
# Input format (EXTENDED_HISTORY): ": 1661789533:0;git push --force"
# Show first and last entry timestamps to understand history span
# Use head/tail on raw file (not sort) since entries are chronological
head -1 ~/.zsh_history | awk -F'[:;]' '{print $2}' | xargs -I{} date -r {} "+%Y-%m-%d"
tail -1 ~/.zsh_history | awk -F'[:;]' '{print $2}' | xargs -I{} date -r {} "+%Y-%m-%d"
```

**Recent command frequency (last 6 months):**

```bash
# Input format (EXTENDED_HISTORY): ": 1661789533:0;git push --force"
# Filter to entries with timestamp in the last 6 months, then count command frequencies
# LC_ALL=C avoids multibyte conversion errors from binary data in history
SIX_MONTHS_AGO=$(date -v-6m +%s)
LC_ALL=C awk -F'[:;]' -v cutoff="$SIX_MONTHS_AGO" \
  '/^: [0-9]/ && $2 >= cutoff {sub(/^: [0-9]+:[0-9]+;/, ""); print $0}' \
  ~/.zsh_history | awk '{print $1}' | sort | uniq -c | sort -rn | head -60
```

**All-time command frequency:**

```bash
# Input format (EXTENDED_HISTORY): ": 1661789533:0;git push --force"
# Strip timestamp prefix, extract first word (command name), count frequencies
LC_ALL=C sed 's/^: [0-9]*:[0-9]*;//' ~/.zsh_history | awk '{print $1}' | sort | uniq -c | sort -rn | head -80
```

Comparing these two tables reveals commands that are trending up (recent > all-time ratio) vs. fading out (high all-time but absent from recent). Focus suggestions on recently active commands.

**Argument patterns for top recent commands:**

```bash
# For each of the top 20 recent commands, show most common argument patterns
SIX_MONTHS_AGO=$(date -v-6m +%s)
for cmd in $(LC_ALL=C awk -F'[:;]' -v cutoff="$SIX_MONTHS_AGO" \
  '/^: [0-9]/ && $2 >= cutoff {sub(/^: [0-9]+:[0-9]+;/, ""); print $0}' \
  ~/.zsh_history | awk '{print $1}' | sort | uniq -c | sort -rn | head -20 | awk '{print $2}'); do
  echo "=== $cmd ==="
  # Input format: ": 1661789533:0;git push --force"
  # Filter to recent, strip timestamp + command name to isolate arguments
  LC_ALL=C awk -F'[:;]' -v cutoff="$SIX_MONTHS_AGO" \
    '/^: [0-9]/ && $2 >= cutoff {sub(/^: [0-9]+:[0-9]+;/, ""); print $0}' \
    ~/.zsh_history | grep "^$cmd " | sed "s/^$cmd //" | sort | uniq -c | sort -rn | head -10
done
```

**Multi-command sequences (recent):**

```bash
# Input format (EXTENDED_HISTORY): ": 1661789533:0;git add . && git commit -m 'fix'"
# Find repeated pipelines and chained commands from the last 6 months
SIX_MONTHS_AGO=$(date -v-6m +%s)
LC_ALL=C awk -F'[:;]' -v cutoff="$SIX_MONTHS_AGO" \
  '/^: [0-9]/ && $2 >= cutoff {sub(/^: [0-9]+:[0-9]+;/, ""); print $0}' \
  ~/.zsh_history | grep -E '&&|\|' | sort | uniq -c | sort -rn | head -30
```

## Analyze Patterns via Sub-Agent

Launch a general-purpose Agent to do pure text pattern matching on the pre-processed data. Include the full frequency tables and dotfiles inventory directly in the agent prompt — the sub-agent needs no tools since all data is already extracted. This is a text analysis task well-suited to a fast, cheap model.

The sub-agent prompt should include both the recent and all-time frequency tables and ask it to identify:

- Commands used 10+ times **recently** lacking aliases
- Multi-step sequences repeated 3+ times recently that could become functions
- Tools active in recent history missing from topic directories
- Commands with verbose repeated flags that could be aliased
- Commands lacking completions from **both** Homebrew site-functions and an explicit `completion.zsh`
- Commands with high all-time counts but zero/low recent usage (candidates for stale config)

The sub-agent returns a structured list of suggestions with category, priority, and rationale.

## Check Installed Tools

Beyond history, the main agent also checks:

- **Brew packages without topics**: compare `brew list` against topic directories
- **Stale aliases**: check if aliased commands still exist on PATH
- **Missing completions**: only flag a tool if it lacks **both** a Homebrew-provided completion (`_tool` in `$HOMEBREW_PREFIX/share/zsh/site-functions/`) **and** an explicit `completion.zsh` in the repo. Most Homebrew formulae ship completions that `compinit` picks up automatically — these do not need a `completion.zsh`. Only suggest one when the tool requires explicit `eval` registration or is not installed via Homebrew.

## Present Results

Merge sub-agent findings with installed-tool observations. Group into these top-level categories (h2):

- **New Aliases** — frequently typed commands that could be shortened
- **Function Candidates** — repeated multi-command sequences
- **Missing Completions** — tools lacking completions from both Homebrew site-functions and an explicit `completion.zsh`
- **New Topics** — tools installed/used but lacking a topic directory
- **Stale Configuration** — aliases pointing to missing commands, unused topics

Within each category, group items under priority subheadings (h3): **High**, **Medium**, **Low**. Omit a priority level if it has no items. This makes it easy to scan for the most impactful changes first.

No implementation — suggestions only.

## Conventions

- Alias naming follows existing patterns: `g`=git, `gb`=git branch, `gc`=git commit
- History format is `EXTENDED_HISTORY`: `: timestamp:duration;command`
- Multi-line history entries use backslash continuation
- Never expose sensitive argument values (tokens, passwords) — frequency analysis naturally avoids this by focusing on command names and flags
- All `sed` commands parsing history must include inline comments with example input/output
