// JSON reduced to one canonical text, so a file an app rewrote can be compared
// against the blob it replaced without key order or indentation counting as a
// change.
//
// Through jq, which is what the shell these callers came from used, and not a
// JSON.parse round trip. JavaScript numbers are doubles: 1700000000000000001
// and 1700000000000000002 both come back as 1700000000000000000, and 1e400
// comes back as null. bin/claude-upgrade's revertCosmeticJsonChanges answers
// "these are the same file" by comparing two canonical texts and then runs
// `git checkout HEAD --` on the working copy, so a canonicalizer that loses a
// distinction discards the edit that made it. jq carries the literal through.
//
// jq is declared in the root Brewfile and was already required by the shell.
// Where it cannot run, every function here answers undefined, which every
// caller reads as "cannot compare" and none reads as "equal".

// A byte order mark decodes to U+FEFF, which both jq and JSON.parse report as a
// stray token. An editor that saved a settings file with one left valid JSON
// behind it, so the mark is not a reason to call the file unreadable.
const BYTE_ORDER_MARK = /^﻿/;

// Parsed for structure, where a caller inspects the shape rather than compares
// texts. Numbers are doubles here too, so nothing that decides whether to
// discard a file may route through this.
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(BYTE_ORDER_MARK, ""));
  } catch {
    return undefined;
  }
}

// `jq -S <filter>`: keys sorted at every depth, one canonical indentation, and
// every scalar spelled as jq spells it. The filter defaults to the identity,
// and a caller comparing everything outside one key passes `del(.hooks)` rather
// than deleting it from a parsed object and re-encoding.
export function canonicalJson(text: string, filter = "."): string | undefined {
  try {
    const run = Bun.spawnSync({
      cmd: ["jq", "-S", filter],
      env: process.env,
      stdin: new TextEncoder().encode(text.replace(BYTE_ORDER_MARK, "")),
      stdout: "pipe",
      stderr: "ignore",
    });
    if (run.exitCode !== 0) return undefined;
    return run.stdout.toString();
  } catch {
    // Bun throws where the shell reported 127. A machine without jq compares
    // nothing rather than comparing wrongly.
    return undefined;
  }
}

export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
