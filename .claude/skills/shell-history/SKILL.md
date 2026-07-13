---
name: shell-history
description: DuckDB data layer over shell command history (atuin) for usage analysis. Use when analyzing how commands are actually used — frequency, alias/function candidates, argument patterns, sequences. Not for editing config, querying Claude Code sessions, or non-shell data sources.
allowed-tools:
  - "Bash(${CLAUDE_SKILL_ROOT}/scripts/query.sh:*)"
---

# Shell History

A read-only DuckDB data layer over shell command history for usage analysis. This skill reads and analyzes; it never modifies config.

## Runner

Run a named query with [`scripts/query.sh`](scripts/query.sh):

```
scripts/query.sh <query-name> [--recent <6m|30d|1y>] [-n <limit>]
```

- `--recent <dur>` scopes to a recent window (`6m`, `30d`, `1y`); omit for all-time.
- `-n <limit>` caps rows (per query defaults apply when omitted).

The named queries and the views they build on are cataloged in [`references/catalog.md`](references/catalog.md). Read it before running a query you have not used.

## Contract

- **Source: atuin only.** History comes from atuin's SQLite db, attached read-only. The runner resolves the path from `ATUIN_HISTORY_DB` or `$XDG_DATA_HOME/atuin/history.db` (DuckDB cannot expand `~` in `ATTACH`). A second read-only source could be attached later; today the layer is anchored on atuin.
- **In-memory only.** Every run is a fresh in-memory DuckDB. No `.duckdb` file is written anywhere.
- **Views, then queries.** After the attach, the runner `.read`s `resources/views.sql` to build the semantic layer, then reads the query. Queries read `FROM history` (the normalized base view), never the raw attached table, so the `deleted_at`/empty-command filter lives in one place.
- **Only `command` and `timestamp` are reliable.** Rows imported from `~/.zsh_history` carry `exit = -1`, `cwd = 'unknown'`, `duration = 0`. The views expose only trustworthy fields. See the source caveat in [`references/catalog.md`](references/catalog.md).
- **Suggest-only.** The layer surfaces patterns for a human to act on. It never edits dotfiles.

## Consumers

`dotfiles-suggestions` builds on this layer via the sibling runner (`../shell-history/scripts/query.sh`). New analyses should read the shared views rather than re-attaching the source.
