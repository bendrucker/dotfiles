// The full record of every run that hit one cause, kept on disk beside the job's
// latches.
//
// The to-do is the reading surface and the log is the archive. Every run appends
// here whether or not its output also fits in the note, which is what makes the
// history survive the ways the note cannot grow: a note near its limit, a Things
// auth token that was never set up, a to-do Ben has since completed.
//
// The counter beside it answers a narrower question: how many runs the to-do
// standing right now has seen. That stops being the archive's length once Ben
// completes a to-do and the cause comes back, and it is the number the title
// shows and the escalation to Today fires on.

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
  try {
    rmSync(escalatedPath(job, cause), { force: true });
  } catch {
    // The new to-do inherits the finished one's escalation and stays in Anytime.
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
