-- Span of recorded history: first and last command dates.
-- Params: cutoff (epoch seconds; NULL for all-time).
SELECT
  min(ts)::date AS first_entry,
  max(ts)::date AS last_entry
FROM history
WHERE getvariable('cutoff') IS NULL OR epoch(ts) >= getvariable('cutoff');
