// What a failure is, reduced to something two runs can be compared on.
//
// A to-do is worth filing once per cause, so a cause needs an identity that
// survives the parts of a log that differ every night and changes when the
// failure itself does. That is the failing command plus one line of its output:
// the first line the child tool used to say what went wrong, with the volatile
// spans in it replaced by their shapes.
//
// Neither half works alone. The command alone collapses every way a step can
// break into one to-do, leaving the second kind of failure silent behind the
// latch the first one set. The whole output alone never matches itself twice,
// since a log carries a timestamp, a revision, or a duration somewhere in it.

import { createHash } from "node:crypto";
import { stripCsi } from "#jobs/excerpt";

// Enough to separate the causes one job produces, and short enough to fit
// the marker line a human reads past.
const FINGERPRINT_LENGTH = 12;

// The level tokens gum puts at the head of a line, which is how this repo's own
// scripts narrate. Those lines say which step broke, which the job name already
// says. The child's own lines say why, and that is the part a cause is built
// from. bin/dotfiles-upgrade overrides this where a WARN line it logged is the
// discriminating one.
const GUM_LEVEL = /^(DEBU|INFO|WARN|ERRO|FATA)\b/;

// Matched against the whole line because the marker is as often at the front
// ("fatal: ...") as buried in it ("... : Permission denied").
const DIAGNOSIS =
  /\b(error|errors|fatal|failed|failure|cannot|can't|unable|denied|refused|missing|no such|not found|timed out|aborted)\b/i;

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

// The line of a log that says what went wrong. The first line carrying a word a
// tool reports failure with, skipping what this repo's own scripts logged, and
// falling back to the last line of output where nothing announced itself: a
// child that failed without a recognizable diagnosis still ended where it broke.
export function distinctiveLine(output: string): string {
  const lines = stripCsi(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return "";

  const diagnosis = lines.find((line) => !GUM_LEVEL.test(line) && DIAGNOSIS.test(line));
  return diagnosis ?? lines[lines.length - 1];
}

// The identity of a failure: which command broke, and the one line saying how,
// with what differs run to run taken out of it.
export function causeFingerprint(command: string, output: string): string {
  return digest(`${command}\n${normalizeVolatile(distinctiveLine(output))}`);
}

// For a report whose cause the caller already knows: a set of standing findings,
// or a fingerprint a job derived itself.
//
// Hashed as given. The volatile shapes are not taken out, because a caller that
// picked this material picked it for what discriminates one cause from another,
// and that is regularly something normalizeVolatile treats as noise. It reads a
// hex digest as one `<hex>`, so every claude-sync failure would file against the
// to-do the first one opened.
export function causeOf(parts: string[]): string {
  return digest(parts.map((part) => `${part}\n`).join(""));
}

function digest(material: string): string {
  return createHash("sha1").update(material).digest("hex").slice(0, FINGERPRINT_LENGTH);
}
