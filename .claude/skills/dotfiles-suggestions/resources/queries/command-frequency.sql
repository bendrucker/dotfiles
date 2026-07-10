-- First-token frequency: which base commands are typed most.
-- Params: cutoff (epoch seconds; NULL for all-time), limit (row cap).
SELECT
  split_part(command, ' ', 1) AS command,
  count(*) AS uses
FROM atuin.history
WHERE deleted_at IS NULL AND command != ''
  AND (getvariable('cutoff') IS NULL OR timestamp / 1e9 >= getvariable('cutoff'))
GROUP BY 1
ORDER BY uses DESC
LIMIT getvariable('limit');
