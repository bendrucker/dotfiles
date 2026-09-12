// The full record of every run that hit one cause, kept on disk beside the job's
// latches.
//
// The to-do is the reading surface and the log is the archive. Every run appends
// here whether or not its output also fits in the note, which is what makes the
// history survive the ways the note cannot grow: a note near its limit, a Things
// auth token that was never set up, a to-do Ben has since completed.
//
// It is also the run counter. The to-do's title carries how many runs have hit
// the cause, and counting the headers in this file answers that without a second
// piece of state to keep in step with the first.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TRAILING_NEWLINES, stateDir } from "#jobs/state";

const RUNS = "runs";

// Opens a run's entry and is what `runCount` counts. Distinctive enough that a
// log line reproducing it would have to be deliberate.
const RUN_HEADER = "=== run ";

export function runLogPath(job: string, cause: string): string {
  return join(stateDir(), RUNS, `${job}-${cause}.log`);
}

// Records one run and answers how many have hit this cause, the new one counted.
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
  return runCount(job, cause);
}

export function runCount(job: string, cause: string): number {
  try {
    return readFileSync(runLogPath(job, cause), "utf8").split(RUN_HEADER).length - 1;
  } catch {
    return 1;
  }
}
