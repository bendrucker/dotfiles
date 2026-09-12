// The full record of every run that hit one cause, kept beside the job's latches.
// The to-do is the reading surface and this is the archive: every run appends
// here whether or not its output also fits in the note.
//
// The counter beside it holds how many runs the to-do standing right now has
// seen, which diverges from the archive's length once a completed cause returns.
// That is the number the title shows and the escalation to Today fires on.

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRAILING_NEWLINES, stateDir } from "#jobs/state";

const RUNS = "runs";

// Distinctive enough that a log line reproducing it would have to be deliberate.
const RUN_HEADER = "=== run ";

export function runLogPath(job: string, cause: string): string {
  return join(stateDir(), RUNS, `${job}-${cause}.log`);
}

function countPath(job: string, cause: string): string {
  return join(stateDir(), RUNS, `${job}-${cause}.count`);
}

function escalatedPath(job: string, cause: string): string {
  return join(stateDir(), RUNS, `${job}-${cause}.escalated`);
}

// A log that cannot be written reports the run as the first, which files a to-do
// rather than appending to one: a duplicate is the better failure.
export function recordRun(job: string, cause: string, run: { at: string; output: string }): number {
  try {
    mkdirSync(join(stateDir(), RUNS), { recursive: true });
    const entry = `${RUN_HEADER}${run.at} ===\n${run.output.replace(TRAILING_NEWLINES, "")}\n\n`;
    appendFileSync(runLogPath(job, cause), entry);
  } catch {
    return 1;
  }
  const runs = storedCount(job, cause) + 1;
  writeCount(job, cause, runs);
  return runs;
}

// Starts the count over, which filing a new to-do against this cause does. The
// archive is untouched: the runs the finished to-do carried are still history,
// they are just not this to-do's.
export function resetRuns(job: string, cause: string): void {
  writeCount(job, cause, 1);
  releaseEscalation(job, cause);
}

// Hands the claim back where the run that took it could not use it. A removal
// that fails leaves the cause in Anytime, which the run count in the title still
// shows aging.
export function releaseEscalation(job: string, cause: string): void {
  try {
    rmSync(escalatedPath(job, cause), { force: true });
  } catch {
    // The escalation stays claimed.
  }
}

// Takes the one move into Today this to-do gets, and answers false to every run
// after. Exclusive creation is what decides it, and resetRuns clearing the
// marker is what gives the next to-do its own.
export function claimEscalation(job: string, cause: string): boolean {
  try {
    mkdirSync(join(stateDir(), RUNS), { recursive: true });
    writeFileSync(escalatedPath(job, cause), "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function storedCount(job: string, cause: string): number {
  try {
    const count = Number.parseInt(readFileSync(countPath(job, cause), "utf8").trim(), 10);
    return Number.isInteger(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

function writeCount(job: string, cause: string, count: number): void {
  try {
    mkdirSync(join(stateDir(), RUNS), { recursive: true });
    writeFileSync(countPath(job, cause), `${count}\n`);
  } catch {
    // A counter that cannot be written costs the count rather than the run: the
    // archive already has the output, and the to-do reads as its first run.
  }
}
