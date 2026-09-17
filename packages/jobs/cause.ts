// What a failure is, reduced to something two runs can be compared on: the
// failing command plus the output line saying what went wrong, with the
// volatile spans replaced by their shapes.
//
// Neither half works alone. The command alone collapses every way a step can
// break into one to-do. The whole output alone matches itself twice, since a log
// carries a timestamp, a revision, or a duration somewhere in it.

import { createHash } from "node:crypto";
import { stripCsi } from "#jobs/excerpt";

// Enough to separate the causes one job produces, and short enough to fit
// the marker line a human reads past.
const FINGERPRINT_LENGTH = 12;

// The level tokens gum puts at the head of a line, which is how this repo's own
// scripts narrate. Those lines say which step broke, which the job name already
// carries, so a cause is built from the child's own lines instead.
const GUM_LEVEL = /^(DEBU|INFO|WARN|ERRO|FATA)\b/;

// The words a tool reports failure with. Matched against the whole line because
// the marker is as often at the front ("fatal: ...") as buried in it
// ("... : Permission denied").
const FAILURE_WORDS =
  "error|errors|fatal|failed|failure|cannot|can't|unable|denied|refused|missing|no such|not found|timed out|aborted";

const DIAGNOSIS = new RegExp(`\\b(${FAILURE_WORDS})\\b`, "i");

// A tally of nothing gone wrong, which a step narrates on its way past: "0
// failed", "no errors", "0 test failures". It carries the vocabulary without
// the event, so it is cut from a line before the words above are looked for.
// Cut rather than vetoing the line, so one reporting both a zero and a real
// failure still reads as a failure.
//
// Built from the same words, so the two cannot drift into a count one treats as
// a tally and the other reads as a diagnosis. The optional word between the
// count and the noun is what "0 test failures" needs, and it cannot swallow a
// real diagnosis, since the word after it still has to be one of these.
const ZERO_TALLY = new RegExp(`\\b(?:0|no)\\s+(?:\\w+\\s+)?(?:${FAILURE_WORDS})\\b`, "gi");

// Spans that differ between two runs of one unchanged failure. Ordered so the
// wider shapes are consumed before the narrower ones can eat into them: a
// duration is digits, and a timestamp is digits and colons.
const VOLATILE: Array<[RegExp, string]> = [
  // 2026-09-11T03:00:04Z, and the same date and clock time spelled apart.
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<time>"],
  [/\b\d{4}-\d{2}-\d{2}\b/g, "<date>"],
  [/\b\d{2}:\d{2}:\d{2}\b/g, "<time>"],
  // "after 30012 ms", "took 1.4s".
  [/\b\d+(\.\d+)?\s?(ms|s|m|h|secs?|seconds?|mins?|minutes?|hours?)\b/g, "<duration>"],
  [/\b\d+(\.\d+)?\s?[KMGTP]i?B\b/gi, "<size>"],
  [/\bpid\s+\d+/gi, "pid <n>"],
  // Git object names, uuids, and the random tails macOS gives a temp directory.
  // Seven is where git's own abbreviation starts.
  [/\b[0-9a-f]{7,}\b/gi, "<hex>"],
];

// A path under the home directory names the same file on both machines once the
// prefix is gone, and the prefix is the half that differs between them.
function unhome(line: string): string {
  const home = process.env.HOME;
  return home ? line.split(home).join("~") : line;
}

export function normalizeVolatile(line: string): string {
  return VOLATILE.reduce((text, [pattern, shape]) => text.replace(pattern, shape), unhome(line));
}

// The line of a log that says what went wrong. The last line carrying a word a
// tool reports failure with, skipping what this repo's own scripts logged, and
// falling back to the last line of output where nothing announced itself: a
// child that failed without a recognizable diagnosis still ended where it broke.
//
// Read from the end for the same reason the note keeps the tail: a run stops
// where it broke, and a long install narrates plenty on the way there. The cost
// is a step whose own output ends in cascade lines, where the last of them says
// less than the first ("command not found" after the line naming the file that
// was missing). The note carries the surrounding tail either way, so the cause
// line loses specificity there rather than the reader losing the root.
export function distinctiveLine(output: string): string {
  const lines = stripCsi(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return "";

  const diagnosis = lines.findLast(diagnoses);
  return diagnosis ?? lines[lines.length - 1];
}

function diagnoses(line: string): boolean {
  return !GUM_LEVEL.test(line) && DIAGNOSIS.test(line.replace(ZERO_TALLY, ""));
}

// The identity of a failure: which command broke, and the one line saying how,
// with what differs run to run taken out of it.
export function causeFingerprint(command: string, output: string): string {
  return digest(`${command}\n${normalizeVolatile(distinctiveLine(output))}`);
}

// For a report whose cause the caller already knows: a set of standing findings,
// or a fingerprint a job derived itself. Hashed as given, because a caller picked
// this material for what discriminates one cause from another and
// normalizeVolatile regularly treats that as noise. It reads a hex digest as one
// `<hex>`, which would file every claude-sync failure against one to-do.
export function causeOf(parts: string[]): string {
  return digest(parts.map((part) => `${part}\n`).join(""));
}

function digest(material: string): string {
  return createHash("sha1").update(material).digest("hex").slice(0, FINGERPRINT_LENGTH);
}
