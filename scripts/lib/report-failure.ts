// Failure reporting for the unattended (3am launchd) jobs: a per-job latch, a
// Things to-do filed through `open`, and a Darwin notification. bin/report-failure
// is the CLI over this, and scripts/lib/report-failure.sh the shim the jobs source.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { dirname, join } from "node:path";

// Things stores 10,000 characters of notes and silently drops the rest. It cuts
// the tail, which is the wrong end to lose, since a job fails at the end of its
// log.
//
// The unit is UTF-16 code units: the notes field is an NSString, which is what
// Things counts, and it is also what String.length reports and what String.slice
// cuts on. Measuring and slicing in one unit is the point. A budget counted in
// characters and spent by a byte-wise cut disagree on every non-ASCII log.
export const THINGS_NOTES_LIMIT = 10_000;

// Reading a latch file back strips its trailing newline, so anything compared
// against one has to be stripped the same way.
const TRAILING_NEWLINES = /\n+$/;

export function elisionMarker(elided: number, total: number): string {
  return `[${elided} of ${total} characters elided]`;
}

// Reduce `output` to `budget` code units, keeping its end and saying how much was
// dropped. What survives resumes at a line boundary, or at a word boundary when
// the budget lands inside a line longer than itself. A budget too small to hold
// that accounting yields nothing.
export function trimOutput(output: string, budget: number): string {
  if (output.length <= budget) return output;

  // The marker spends the budget it introduces, so measure it first, with the
  // total standing in for the smaller elided count to keep the width an upper
  // bound. The 1 is the newline that separates the marker from the log.
  const worstCase = elisionMarker(output.length, output.length);
  const remaining = budget - worstCase.length - 1;
  // Too little room to say even how much was dropped. Saying it anyway is what
  // pushes the note past the limit the budget was measured against.
  if (remaining < 0) return "";

  // The note keeps no trailing blank lines, since the closing fence sits directly
  // after the last log line. Dropping them here rather than at the fence is what
  // lets the marker count them among what was lost.
  let kept = output.slice(output.length - remaining).replace(TRAILING_NEWLINES, "");
  // A cut between the halves of a surrogate pair opens the log with an orphaned
  // code unit that renders as a replacement character. The boundary strip below
  // usually swallows it, but not in a kept region holding one unbroken token,
  // which is exactly the case the word-boundary branch exists for.
  if (kept.length > 0 && isLowSurrogate(kept.charCodeAt(0))) kept = kept.slice(1);

  // Resume at a boundary so the log does not open partway through a word. A final
  // line longer than the budget leaves no newline in what was kept, and the space
  // is the best boundary that line offers.
  const newline = kept.indexOf("\n");
  const space = kept.indexOf(" ");
  if (newline !== -1) kept = kept.slice(newline + 1);
  else if (space !== -1) kept = kept.slice(space + 1);

  return `${elisionMarker(output.length - kept.length, output.length)}\n${kept}`;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

export interface FailureNote {
  host: string;
  time: string;
  revision: string;
  extraMeta: string;
  command: string;
  outputHeading: string;
  output: string;
}

export function buildNotes(note: FailureNote): string {
  let notes =
    `- **Host:** ${note.host}\n` +
    `- **Time:** ${note.time}\n` +
    `- **Revision:** ${note.revision}`;
  if (note.extraMeta) notes += `\n${note.extraMeta}`;

  const suffix = "\n```";
  notes += `\n\n\`\`\`sh\n${note.command}\n\`\`\`\n\n## ${note.outputHeading}\n\`\`\`\n`;

  // The budget is what the limit leaves after the surrounding note, so this
  // subtraction and the one inside trimOutput have to agree or the note overruns.
  const trimmed = trimOutput(note.output, THINGS_NOTES_LIMIT - notes.length - suffix.length);
  // The closing fence sits on its own line directly after the last log line, so
  // trailing blank lines in the log would otherwise push it away from the text.
  return notes + trimmed.replace(TRAILING_NEWLINES, "") + suffix;
}

export function timestamp(at = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(at);
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return (
    `${field("year")}-${field("month")}-${field("day")} ` +
    `${field("hour")}:${field("minute")}:${field("second")} ${field("timeZoneName")}`
  );
}

// Percent-encode everything outside the unreserved set, so neither field can leave
// a literal % or & behind to split the URL apart. encodeURIComponent spares
// !'()*, which the unreserved set does not.
function encodeField(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function thingsAddUrl(title: string, notes: string): string {
  return `things:///add?title=${encodeField(title)}&notes=${encodeField(notes)}&when=today`;
}

export function statusFile(job: string): string {
  const state = process.env.XDG_STATE_HOME || join(process.env.HOME || homedir(), ".local", "state");
  return join(state, "dotfiles", `${job}.status`);
}

// A missing latch is a job's first-ever failure, and reads as the empty string so
// it compares unequal to any latch value and files.
export function readLatch(job: string): string {
  try {
    return readFileSync(statusFile(job), "utf8").replace(TRAILING_NEWLINES, "");
  } catch {
    return "";
  }
}

export function writeLatch(job: string, value: string): void {
  const path = statusFile(job);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${value}\n`);
}

export function latchValue(fingerprint: string): string {
  // A fingerprint ending in a newline would never compare equal to itself: the
  // latch file's own trailing newline is stripped on the way back in, and the
  // fingerprint's goes with it, so the job files a fresh to-do every run.
  return fingerprint ? `failed ${fingerprint.replace(TRAILING_NEWLINES, "")}` : "failed";
}

export function reportSuccess(job: string): void {
  writeLatch(job, "ok");
}

export interface FailureReport {
  job: string;
  title: string;
  command: string;
  output: string;
  revision: string;
  extraMeta: string;
  outputHeading: string;
  fingerprint: string;
}

// File a Things to-do describing the failure and notify, but only on the
// transition into a failed state. Returns the exit status the CLI should carry:
// nonzero only when `open` refused the URL.
export function reportFailure(report: FailureReport): number {
  const latch = latchValue(report.fingerprint);
  const prior = readLatch(report.job);
  // The latch moves before anything is filed. A filing that fails therefore
  // leaves a latch claiming a to-do exists, and the failure stays quiet until the
  // job recovers or its fingerprint moves.
  writeLatch(report.job, latch);

  if (prior === latch) {
    log(`${report.job} still failing - to-do already filed, staying quiet`);
    return 0;
  }

  log(`Creating Things to-do for ${report.job} failure`);

  const notes = buildNotes({
    host: hostname().split(".")[0],
    time: timestamp(),
    revision: report.revision,
    extraMeta: report.extraMeta,
    command: report.command,
    outputHeading: report.outputHeading,
    output: report.output,
  });

  const opened = run(["open", thingsAddUrl(report.title, notes)], "inherit");
  if (opened !== 0) return opened;

  notify(report.title, `${report.job} failed - see Things to-do`);
  return 0;
}

export function notificationScript(title: string, message: string, sound: string): string {
  return (
    `display notification ${appleScriptString(message)} ` +
    `with title ${appleScriptString(title)} sound name ${appleScriptString(sound)}`
  );
}

// Titles reach here built by interpolation, so a " or a \ in one would otherwise
// make the script invalid. osascript's complaint is discarded, so the failure
// would surface only as a notification that never appears.
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Nothing notifies where osascript is absent, which is every Linux run and CI.
// Resolving the binary rather than reading process.platform is what makes that
// observable: a caller that puts its own osascript on PATH sees the call, and
// the check answers the question the call actually depends on. The callers here
// abort on any nonzero status, so the resolution failure has to be caught before
// the spawn, and osascript's own failure stays discarded.
export function notify(title: string, message: string, sound = "Basso"): void {
  const osascript = Bun.which("osascript", { PATH: process.env.PATH });
  if (!osascript) return;
  run([osascript, "-e", notificationScript(title, message, sound)], "ignore");
}

// gum writes its log lines to stderr, where a caller capturing stdout with $()
// will not pick them up.
function log(message: string): void {
  run(["gum", "log", "--level", "info", message], "inherit");
}

// The environment goes across explicitly because Bun otherwise resolves a bare
// command name against the PATH it captured at startup, and a caller that
// adjusted PATH afterwards would reach a different binary than it meant to.
function run(cmd: string[], stderr: "inherit" | "ignore"): number {
  return Bun.spawnSync({ cmd, env: process.env, stdio: ["ignore", "ignore", stderr] }).exitCode;
}
