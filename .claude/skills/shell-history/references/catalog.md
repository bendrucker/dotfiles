# Shell History Query Catalog

Full descriptions of every named query and the views they read, for the `shell-history` data layer. Load this before running a query you have not used.

The runner ([`scripts/query.sh`](../scripts/query.sh)) builds an in-memory DuckDB: it attaches the source read-only, `.read`s [`resources/views.sql`](../resources/views.sql) to construct the view layer, binds `cutoff`/`limit`, then reads the named query from [`resources/queries/`](../resources/queries). No database file is ever written.

## Source Caveat

The source is atuin's SQLite history. Rows imported from the legacy `~/.zsh_history` lack context fields: `exit = -1`, `cwd = 'unknown'`, `duration = 0`. Only `command` and `timestamp` are trustworthy, which is why the view layer exposes nothing else. Native records added going forward carry real `exit`/`cwd`/`duration`; context-aware queries wait on that data to accrue.

## Views

Built by `views.sql`, in dependency order. Queries read `FROM history`; the derived views are a reusable semantic layer for ad-hoc DuckDB analysis.

- `history`: normalized base view. Applies `deleted_at IS NULL AND command != ''` once, so no downstream query repeats it. Columns: `command` (full command line), `first_token` (`split_part(command, ' ', 1)`, the base command), `ts` (a real `TIMESTAMP` from atuin's nanosecond epoch).
- `command_frequency`: one row per history entry reduced to its base command. Columns: `command` (the `first_token`), `ts`. Group and count for base-command frequency.
- `command_prefix`: two-word command prefixes (e.g. `git commit`), for commands with at least two tokens. Columns: `prefix`, `ts`. The alias signal.
- `command_args`: each command split into base token and the argument string that follows. Columns: `command` (base token), `args` (everything after the first token), `ts`. Surfaces repeated verbose flag combinations.

## Named Queries

Every query takes `cutoff` (epoch seconds; NULL for all-time, set via `--recent <dur>`) and, except `date-range`, `limit` (`-n`). A bare run is unfiltered.

- `command-frequency`: first-token frequency, which base commands are typed most. Ranked table of `command`, `uses`.
- `alias-candidates`: frequent two-word prefixes used at least 10 times. The headline alias signal. Columns: `prefix`, `uses`.
- `arg-patterns`: for each of the top `limit` commands, the argument strings typed most often after it (top 10 per command). Columns: `cmd`, `args`, `uses`. Here `limit` caps the number of top commands; output rows can exceed it.
- `sequences`: multi-command chains and pipelines (`&&` or `|`), by frequency. Candidates for functions. Columns: `command`, `uses`.
- `date-range`: span of recorded history. Columns: `first_entry`, `last_entry`.
