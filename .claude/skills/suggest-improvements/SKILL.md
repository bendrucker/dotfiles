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
- **Completions**: `Glob` for `*/completion.zsh`
- **Topics**: list topic directories (top-level dirs excluding `.git`, `.github`, `.claude`, `scripts`, `bin`, `tmp`)
- **Brew packages**: `Grep` for `^brew ` across `*/Brewfile`
- **bin/ scripts**: list `bin/`

Run all of these in parallel.

## Pre-process History

Run Bash commands to produce compact frequency tables from `~/.zsh_history`. All `sed` commands that parse history must include an inline comment documenting the input format they handle.

**Command frequency table:**

```bash
# Input format (EXTENDED_HISTORY): ": 1661789533:0;git push --force"
# Strip timestamp prefix, extract first word (command name), count frequencies
sed 's/^: [0-9]*:[0-9]*;//' ~/.zsh_history | awk '{print $1}' | sort | uniq -c | sort -rn | head -80
```

**Argument patterns for top commands:**

```bash
# For each of the top 20 commands, show most common argument patterns
for cmd in $(sed 's/^: [0-9]*:[0-9]*;//' ~/.zsh_history | awk '{print $1}' | sort | uniq -c | sort -rn | head -20 | awk '{print $2}'); do
  echo "=== $cmd ==="
  # Input format: ": 1661789533:0;git push --force"
  # Strip timestamp, then strip command name to isolate arguments
  # e.g., "git push --force" → "push --force"
  sed 's/^: [0-9]*:[0-9]*;//' ~/.zsh_history | grep "^$cmd " | sed "s/^$cmd //" | sort | uniq -c | sort -rn | head -10
done
```

**Multi-command sequences:**

```bash
# Input format (EXTENDED_HISTORY): ": 1661789533:0;git add . && git commit -m 'fix'"
# Find repeated pipelines and chained commands
sed 's/^: [0-9]*:[0-9]*;//' ~/.zsh_history | grep -E '&&|\|' | sort | uniq -c | sort -rn | head -30
```

## Analyze Patterns via Sub-Agent

Launch a general-purpose Agent to do pure text pattern matching on the pre-processed data. Include the full frequency tables and dotfiles inventory directly in the agent prompt — the sub-agent needs no tools since all data is already extracted. This is a text analysis task well-suited to a fast, cheap model.

The sub-agent prompt should ask it to identify:

- Commands used 10+ times lacking aliases
- Multi-step sequences repeated 3+ times that could become functions
- Tools in history missing from topic directories
- Commands with verbose repeated flags that could be aliased
- Commands likely supporting completions without a `completion.zsh`

The sub-agent returns a structured list of suggestions with category, priority, and rationale.

## Check Installed Tools

Beyond history, the main agent also checks:

- **Brew packages without topics**: compare `brew list` against topic directories
- **Stale aliases**: check if aliased commands still exist on PATH
- **Missing completions**: for top-used commands, check if the tool supports `completion zsh` or similar but lacks a `completion.zsh`

## Present Results

Merge sub-agent findings with installed-tool observations. Group into these top-level categories (h2):

- **New Aliases** — frequently typed commands that could be shortened
- **Function Candidates** — repeated multi-command sequences
- **Missing Completions** — tools supporting shell completions without a `completion.zsh`
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
