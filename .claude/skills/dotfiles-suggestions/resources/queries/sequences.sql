-- Multi-command chains and pipelines, by frequency: candidates for functions.
-- Params: cutoff (epoch seconds; NULL for all-time), limit (row cap).
SELECT
  command,
  count(*) AS uses
FROM atuin.history
WHERE deleted_at IS NULL AND command != ''
  AND (command LIKE '%&&%' OR command LIKE '%|%')
  AND (getvariable('cutoff') IS NULL OR timestamp / 1e9 >= getvariable('cutoff'))
GROUP BY 1
ORDER BY uses DESC
LIMIT getvariable('limit');
