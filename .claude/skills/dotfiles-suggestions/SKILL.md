---
name: dotfiles-suggestions
description: Analyze shell history and installed tools to suggest dotfiles improvements. Use when looking for missing aliases, functions, completions, or topics based on actual usage patterns. Trigger on "what aliases should I add", "what's missing from my dotfiles", "audit my shell setup", "suggest improvements", "what should I add to my dotfiles", or any request to review dotfiles for gaps.
allowed-tools:
  - "Bash(${CLAUDE_SKILL_ROOT}/../shell-history/scripts/query.sh:*)"
---

# Suggest Improvements

Analyze shell history and installed tools to surface dotfiles improvements. This skill only suggests. It never modifies files.

## Gather Dotfiles Inventory

Inventory what the dotfiles already provide:

- **Aliases**: `Grep` for `^alias ` across `*/aliases.zsh` and `*/*.zsh`
- **Functions**: `Grep` for function definitions across `*/*.zsh`
- **Completions**: `Glob` for `*/completion.zsh`, plus list Homebrew-provided completions via `ls $HOMEBREW_PREFIX/share/zsh/site-functions/_*`
- **Topics**: list topic directories (top-level dirs excluding `.git`, `.github`, `.claude`, `scripts`, `bin`, `tmp`)
- **Brew packages**: `Grep` for `^brew ` across `*/Brewfile`
- **bin/ scripts**: list `bin/`

Run all of these in parallel.

## Pre-Process History

History analysis runs on the shared `shell-history` data layer. Use the sibling runner `../shell-history/scripts/query.sh <query-name>` to produce compact frequency tables from atuin's command history. Each query supports `--recent <duration>` (e.g. `6m`, `30d`, `1y`) and `-n <limit>`. The available queries and views are cataloged in `../shell-history/references/catalog.md`.

History spans a long time, so raw counts can be misleading. A command used heavily years ago but not recently is not a good alias candidate. Split analysis into **recent** (last 6 months) and **all-time** to distinguish active patterns from stale ones.

Run all of these in parallel:

- **Date range**: `../shell-history/scripts/query.sh date-range`
- **Recent frequency**: `../shell-history/scripts/query.sh command-frequency --recent 6m`
- **All-time frequency**: `../shell-history/scripts/query.sh command-frequency`
- **Alias candidates**: `../shell-history/scripts/query.sh alias-candidates --recent 6m`
- **Argument patterns**: `../shell-history/scripts/query.sh arg-patterns --recent 6m`
- **Multi-command sequences**: `../shell-history/scripts/query.sh sequences --recent 6m`

Comparing recent vs all-time frequency reveals commands trending up (recent > all-time ratio) vs. fading out (high all-time but absent from recent). Focus suggestions on recently active commands.

## Analyze Patterns via Sub-Agent

Launch a general-purpose Agent to do pure text pattern matching on the pre-processed data. Include the full frequency tables and dotfiles inventory directly in the agent prompt. The sub-agent needs no tools since all data is already extracted. This is a text analysis task well-suited to a fast, cheap model.

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
- **Missing completions**: only flag a tool if it lacks **both** a Homebrew-provided completion (`_tool` in `$HOMEBREW_PREFIX/share/zsh/site-functions/`) **and** an explicit `completion.zsh` in the repo. Most Homebrew formulae ship completions that `compinit` picks up automatically. Those do not need a `completion.zsh`. Only suggest one when the tool requires explicit `eval` registration or is not installed via Homebrew.

## Present Results

Merge sub-agent findings with installed-tool observations. Group into these top-level categories (h2):

- **New Aliases**: frequently typed commands that could be shortened
- **Function Candidates**: repeated multi-command sequences
- **Missing Completions**: tools lacking completions from both Homebrew site-functions and an explicit `completion.zsh`
- **New Topics**: tools installed/used but lacking a topic directory
- **Stale Configuration**: aliases pointing to missing commands, unused topics

Within each category, group items under priority subheadings (h3): **High**, **Medium**, **Low**. Omit a priority level if it has no items. This makes it easy to scan for the most impactful changes first.

No implementation. Suggestions only.

## Conventions

- Alias naming follows existing patterns: `g`=git, `gb`=git branch, `gc`=git commit
- History is read through the shared `shell-history` skill, which attaches atuin's SQLite db read-only in an in-memory DuckDB and builds a view layer. It never persists a database or modifies history.
- Imported rows lack context fields (`exit=-1`, `cwd='unknown'`, `duration=0`), so only `command` and `timestamp` are reliable for frequency analysis. Native records added going forward carry real `exit`/`cwd`/`duration`. Context-aware queries (clustering by cwd, filtering by exit) are deferred to [#536](https://github.com/bendrucker/dotfiles/issues/536) pending data accrual.
- Never expose sensitive argument values (tokens, passwords). Frequency analysis naturally avoids this by focusing on command names and flags.
