-- Semantic view layer over the attached shell-history source (atuin today).
-- Built into an in-memory DuckDB by scripts/query.sh after the read-only ATTACH,
-- before any query runs. Queries read FROM these views, never FROM atuin.history.
--
-- Views are param-free: cutoff filtering stays in the queries via
-- getvariable('cutoff') against history.ts, so no view depends on a session
-- variable (which would make the view fail to build before SET VARIABLE runs).

-- Normalized base view. Applies the deleted_at / empty-command filter ONCE here
-- so every downstream query is spared it. `ts` is a real timestamp derived from
-- atuin's nanosecond epoch; `first_token` is the base command.
CREATE OR REPLACE VIEW history AS
SELECT
  command,
  split_part(command, ' ', 1) AS first_token,
  to_timestamp(timestamp / 1e9) AS ts
FROM atuin.history
WHERE deleted_at IS NULL AND command != '';

-- First-token usage counts. The base-command frequency signal.
CREATE OR REPLACE VIEW command_frequency AS
SELECT
  first_token AS command,
  ts
FROM history;

-- Two-word command prefixes (e.g. `git commit`). The headline alias signal.
-- Only rows with at least two whitespace-separated tokens.
CREATE OR REPLACE VIEW command_prefix AS
SELECT
  split_part(command, ' ', 1) || ' ' || split_part(command, ' ', 2) AS prefix,
  ts
FROM history
WHERE command LIKE '% %';

-- Command split into its base token and the argument string that follows.
-- Surfaces verbose repeated flag combinations.
CREATE OR REPLACE VIEW command_args AS
SELECT
  first_token AS command,
  regexp_replace(command, '^\S+\s*', '') AS args,
  ts
FROM history;
