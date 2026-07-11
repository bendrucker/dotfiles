-- Multi-command chains and pipelines, by frequency: candidates for functions.
-- Params: cutoff (epoch seconds; NULL for all-time), limit (row cap).
SELECT
  command,
  count(*) AS uses
FROM history
WHERE (command LIKE '%&&%' OR command LIKE '%|%')
  AND (getvariable('cutoff') IS NULL OR epoch(ts) >= getvariable('cutoff'))
GROUP BY 1
ORDER BY uses DESC
LIMIT getvariable('limit');
