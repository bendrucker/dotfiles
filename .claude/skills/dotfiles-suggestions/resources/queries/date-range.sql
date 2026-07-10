-- Span of recorded history: first and last command dates.
-- Params: cutoff (epoch seconds; NULL for all-time).
SELECT
  min(to_timestamp(timestamp / 1e9))::date AS first_entry,
  max(to_timestamp(timestamp / 1e9))::date AS last_entry
FROM atuin.history
WHERE deleted_at IS NULL AND command != ''
  AND (getvariable('cutoff') IS NULL OR timestamp / 1e9 >= getvariable('cutoff'));
