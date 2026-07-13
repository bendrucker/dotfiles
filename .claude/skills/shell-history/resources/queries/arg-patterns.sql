-- For each of the top commands, the argument strings typed most often after it.
-- Surfaces verbose repeated flag combinations that could be aliased or wrapped.
-- Params: cutoff (epoch seconds; NULL for all-time), limit (number of top commands).
WITH filtered AS (
  SELECT command AS cmd, args
  FROM command_args
  WHERE getvariable('cutoff') IS NULL OR epoch(ts) >= getvariable('cutoff')
),
top_cmds AS (
  SELECT cmd, count(*) AS cmd_uses
  FROM filtered
  GROUP BY cmd
  ORDER BY cmd_uses DESC
  LIMIT getvariable('limit')
),
arg_counts AS (
  SELECT
    f.cmd,
    f.args,
    count(*) AS uses,
    row_number() OVER (PARTITION BY f.cmd ORDER BY count(*) DESC) AS rn
  FROM filtered f
  JOIN top_cmds USING (cmd)
  WHERE f.args != ''
  GROUP BY f.cmd, f.args
)
SELECT arg_counts.cmd, arg_counts.args, arg_counts.uses
FROM arg_counts
JOIN top_cmds USING (cmd)
WHERE arg_counts.rn <= 10
ORDER BY top_cmds.cmd_uses DESC, arg_counts.uses DESC;
