# Screen Time Ingest

`ingest.py` decodes iOS/iPadOS app-focus history from the local Biome store
(synced by Screen Time's "Share Across Devices") into a SQLite database, so the
`activitywatch:activity` skill can report phone/tablet usage alongside the Mac's
own ActivityWatch capture.

## How It Works

Screen Time syncs each remote device's `App.InFocus` stream to
`~/Library/Biome/streams/restricted/App.InFocus/remote/<device>/`. Every record
is one focus-change edge (an app gained or lost the foreground). The ingest:

1. Discovers each remote device dir that holds data.
2. Decodes the SEGB segment files (vendored `ccl_segb`, MIT) and reads three
   protobuf fields per record: foreground flag, `CFAbsoluteTime`, bundle id.
3. Pairs consecutive edges into `[start, end]` intervals.
4. Appends intervals to the store, tracking a per-device timestamp watermark and
   the still-open interval so re-runs are incremental and idempotent.

`com.user.screentime-ingest` (see `macos/`) runs it hourly. It needs Full Disk
Access to read `~/Library/Biome`.

## Store

`~/Library/Application Support/activitywatch/screentime/screentime.db`

- `app_in_focus(device, bundle_id, start_unix, end_unix, duration_s, start_utc)`
- `device(device, model, platform)`
- `ingest_state(device, last_cf, open_bundle, open_start_cf)` holds the per-device ingest watermark

Read it with the same DuckDB `ATTACH ... (READ_ONLY)` pattern the skill uses for
the ActivityWatch db:

```sql
INSTALL sqlite; LOAD sqlite;
ATTACH 'screentime.db' AS st (TYPE sqlite, READ_ONLY);
SELECT bundle_id, sum(duration_s) / 3600 AS hours
FROM st.app_in_focus GROUP BY bundle_id ORDER BY hours DESC;
```

## Limitations

- Durations are best-effort: macOS occasionally logs incomplete foreground
  spans, so totals run slightly under Screen Time.app.
- Apple prunes the raw segment files, so ingest cadence bounds history retention.
- `bundle_id` is the raw identifier (`com.google.ios.youtube`); friendly names
  would need an App Store lookup, left to the reader.
