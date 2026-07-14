#!/usr/bin/env python3
"""Ingest iOS/iPadOS app-focus history from the local Biome store into SQLite.

Screen Time's "Share Across Devices" syncs each remote device's App.InFocus
stream to this Mac under ~/Library/Biome. Every record is a single focus-change
edge (an app gained or lost foreground); pairing consecutive edges yields the
per-app intervals this writes to a local SQLite db, which the activitywatch
skill attaches read-only alongside the Mac's own ActivityWatch capture.

SEGB decoding is delegated to the vendored ccl_segb reader. The App.InFocus
protobuf is decoded inline: only three fields are needed, so the full protobuf
runtime and Apple's schema are avoided.

Reading ~/Library/Biome requires Full Disk Access for whatever runs this.
"""

from __future__ import annotations

import argparse
import datetime as dt
import sqlite3
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))

from ccl_segb import read_segb_file  # noqa: E402
from ccl_segb.ccl_segb_common import EntryState  # noqa: E402

# CFAbsoluteTime counts seconds from 2001-01-01; add this to reach the Unix epoch.
APPLE_EPOCH_OFFSET = 978_307_200

BIOME_BASE = Path.home() / "Library" / "Biome"
APP_IN_FOCUS = BIOME_BASE / "streams" / "restricted" / "App.InFocus" / "remote"
SYNC_DB = BIOME_BASE / "sync" / "sync.db"

DEFAULT_STORE = (
    Path.home()
    / "Library"
    / "Application Support"
    / "activitywatch"
    / "screentime"
    / "screentime.db"
)

# DevicePeer.platform values worth ingesting. The Mac itself (3) is already
# covered by ActivityWatch, so only the phone and tablet are pulled here.
PLATFORM_LABELS = {1: "iOS", 2: "iOS", 3: "macOS", 7: "iPadOS"}


def read_device_meta(sync_db: Path) -> dict[str, dict]:
    """Map device UUID -> {model, platform} from the Biome sync database."""
    if not sync_db.exists():
        return {}
    uri = f"file:{sync_db}?immutable=1"
    with sqlite3.connect(uri, uri=True) as con:
        rows = con.execute(
            "SELECT device_identifier, model, platform FROM DevicePeer WHERE me = 0"
        ).fetchall()
    return {r[0]: {"model": r[1], "platform": r[2]} for r in rows if r[0]}


def discover_devices(sync_db: Path) -> list[dict]:
    """Return every remote device with App.InFocus data, enriched from DevicePeer.

    The Mac's own stream lives under local/, so every remote/ device is a peer
    sharing Screen Time. DevicePeer is consulted only for a model/platform label,
    since data-bearing streams are not always registered there.
    """
    if not APP_IN_FOCUS.is_dir():
        return []
    meta = read_device_meta(sync_db)
    devices = []
    for device_dir in sorted(APP_IN_FOCUS.iterdir()):
        if not device_dir.is_dir():
            continue
        has_data = any(
            p.is_file() for p in device_dir.iterdir() if p.name != "tombstone"
        )
        if not has_data:
            continue
        m = meta.get(device_dir.name, {})
        devices.append(
            {
                "device": device_dir.name,
                "model": m.get("model"),
                "platform": PLATFORM_LABELS.get(m.get("platform"), "unknown"),
            }
        )
    return devices


def _read_varint(buf: bytes, i: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def parse_app_in_focus(data: bytes) -> tuple[float, int, str] | None:
    """Decode an App.InFocus protobuf record into (cf_time, in_foreground, bundle).

    Fields consumed: 3 (in_foreground uint32), 4 (cf_absolute_time double),
    6 (bundle_id string). Everything else is skipped by wire type. Returns None
    if the record lacks a timestamp or bundle id.
    """
    i, n = 0, len(data)
    in_fg: int | None = None
    cf: float | None = None
    bundle: str | None = None
    while i < n:
        tag, i = _read_varint(data, i)
        field, wire = tag >> 3, tag & 0x7
        if wire == 0:
            val, i = _read_varint(data, i)
            if field == 3:
                in_fg = val
        elif wire == 1:
            if field == 4:
                cf = struct.unpack_from("<d", data, i)[0]
            i += 8
        elif wire == 2:
            length, i = _read_varint(data, i)
            if field == 6:
                bundle = data[i : i + length].decode("utf-8", "replace")
            i += length
        elif wire == 5:
            i += 4
        else:
            raise ValueError(f"unsupported wire type {wire}")
    if cf is None or bundle is None or in_fg is None:
        return None
    return cf, in_fg, bundle


def iter_focus_edges(device_dir: Path):
    """Yield (cf_time, in_foreground, bundle_id) for every App.InFocus edge.

    Recent edges can appear in older segment files, so every file is scanned;
    the caller clips by timestamp watermark rather than by file.
    """
    for seg in sorted(p for p in device_dir.iterdir() if p.is_file()):
        try:
            records = read_segb_file(str(seg))
        except ValueError:
            continue  # not a SEGB file (lock, stray)
        for record in records:
            if record.state != EntryState.Written or not any(record.data):
                continue
            try:
                parsed = parse_app_in_focus(record.data)
            except (IndexError, ValueError, struct.error):
                continue
            if parsed is not None:
                yield parsed


def stitch(edges, open_state):
    """Pair focus-change edges into closed [start, end] intervals.

    An interval opens when an app gains foreground and closes when it loses
    foreground or a different app takes over. The last interval stays open and
    is carried across runs via `open_state`.
    """
    intervals = []
    cur = open_state
    for cf, in_fg, bundle in edges:
        if in_fg == 1:
            if cur is not None and cur["bundle"] != bundle:
                intervals.append((cur["bundle"], cur["start_cf"], cf))
                cur = {"bundle": bundle, "start_cf": cf}
            elif cur is None:
                cur = {"bundle": bundle, "start_cf": cf}
        elif cur is not None and cur["bundle"] == bundle:
            intervals.append((cur["bundle"], cur["start_cf"], cf))
            cur = None
    return intervals, cur


def init_store(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS device (
            device   TEXT PRIMARY KEY,
            model    TEXT,
            platform TEXT
        );
        CREATE TABLE IF NOT EXISTS app_in_focus (
            device      TEXT NOT NULL,
            bundle_id   TEXT NOT NULL,
            start_unix  REAL NOT NULL,
            end_unix    REAL NOT NULL,
            duration_s  REAL NOT NULL,
            start_utc   TEXT NOT NULL,
            PRIMARY KEY (device, bundle_id, start_unix)
        );
        CREATE TABLE IF NOT EXISTS ingest_state (
            device        TEXT PRIMARY KEY,
            last_cf       REAL NOT NULL,
            open_bundle   TEXT,
            open_start_cf REAL
        );
        """
    )
    return con


def ingest_device(con: sqlite3.Connection, dev: dict) -> int:
    device_dir = APP_IN_FOCUS / dev["device"]
    if not device_dir.is_dir():
        return 0

    row = con.execute(
        "SELECT last_cf, open_bundle, open_start_cf FROM ingest_state WHERE device = ?",
        (dev["device"],),
    ).fetchone()
    last_cf = row[0] if row else 0.0
    open_state = (
        {"bundle": row[1], "start_cf": row[2]} if row and row[1] is not None else None
    )

    edges = [e for e in iter_focus_edges(device_dir) if e[0] > last_cf]
    edges.sort(key=lambda e: e[0])
    if not edges and open_state is None:
        return 0

    intervals, open_state = stitch(edges, open_state)
    for bundle, start_cf, end_cf in intervals:
        start_unix = start_cf + APPLE_EPOCH_OFFSET
        end_unix = end_cf + APPLE_EPOCH_OFFSET
        con.execute(
            "INSERT OR IGNORE INTO app_in_focus "
            "(device, bundle_id, start_unix, end_unix, duration_s, start_utc) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                dev["device"],
                bundle,
                start_unix,
                end_unix,
                end_unix - start_unix,
                dt.datetime.fromtimestamp(start_unix, dt.timezone.utc).isoformat(),
            ),
        )

    new_last_cf = max((e[0] for e in edges), default=last_cf)
    con.execute(
        "INSERT INTO ingest_state (device, last_cf, open_bundle, open_start_cf) "
        "VALUES (?, ?, ?, ?) ON CONFLICT(device) DO UPDATE SET "
        "last_cf = excluded.last_cf, open_bundle = excluded.open_bundle, "
        "open_start_cf = excluded.open_start_cf",
        (
            dev["device"],
            new_last_cf,
            open_state["bundle"] if open_state else None,
            open_state["start_cf"] if open_state else None,
        ),
    )
    con.execute(
        "INSERT INTO device (device, model, platform) VALUES (?, ?, ?) "
        "ON CONFLICT(device) DO UPDATE SET model = excluded.model, "
        "platform = excluded.platform",
        (dev["device"], dev["model"], dev["platform"]),
    )
    return len(intervals)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db", type=Path, default=DEFAULT_STORE, help="SQLite store path"
    )
    parser.add_argument(
        "--sync-db", type=Path, default=SYNC_DB, help="Biome sync.db path"
    )
    parser.add_argument(
        "--quiet", action="store_true", help="suppress the per-run summary"
    )
    args = parser.parse_args()

    devices = discover_devices(args.sync_db)
    if not devices:
        if not args.quiet:
            print("no iOS/iPadOS App.InFocus data found", file=sys.stderr)
        return 0

    con = init_store(args.db)
    total = 0
    try:
        for dev in devices:
            written = ingest_device(con, dev)
            total += written
            if not args.quiet:
                print(f"{dev['platform']} {dev['device'][:8]}: +{written} intervals")
        con.commit()
    finally:
        con.close()

    if not args.quiet:
        print(f"ingested {total} intervals from {len(devices)} device(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
