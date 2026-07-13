-- First-token frequency: which base commands are typed most.
-- Params: cutoff (epoch seconds; NULL for all-time), limit (row cap).
SELECT
  first_token AS command,
  count(*) AS uses
FROM history
WHERE getvariable('cutoff') IS NULL OR epoch(ts) >= getvariable('cutoff')
GROUP BY 1
ORDER BY uses DESC
LIMIT getvariable('limit');
