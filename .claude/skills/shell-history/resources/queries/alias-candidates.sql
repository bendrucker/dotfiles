-- Frequent two-word command prefixes: the headline alias signal.
-- Only prefixes used at least 10 times survive the HAVING filter.
-- Params: cutoff (epoch seconds; NULL for all-time), limit (row cap).
SELECT
  prefix,
  count(*) AS uses
FROM command_prefix
WHERE getvariable('cutoff') IS NULL OR epoch(ts) >= getvariable('cutoff')
GROUP BY 1
HAVING count(*) >= 10
ORDER BY uses DESC
LIMIT getvariable('limit');
