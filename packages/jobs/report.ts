// Failure reporting for the unattended (3am launchd) jobs: one Things to-do per
// cause per machine, with the runs after the first appended to it. The to-do is
// the record, carrying a marker that names the machine, the job and the cause.
// Completing it says the cause was dealt with, so its return files again.
//
// They land in Anytime rather than Today, which is the working list Ben builds
// each morning. A cause that survives ESCALATE_AFTER runs moves to Today.

import { causeFingerprint, causeOf, distinctiveLine } from "#jobs/cause";
import { machineKey, machineName } from "#jobs/machine";
import {
  claimEscalation,
  recordRun,
  releaseEscalation,
  resetRuns,
  runLogPath,
} from "#jobs/run-log";
import { TRAILING_NEWLINES, readLatch, writeLatch } from "#jobs/state";
import {
  THINGS_NOTES_LIMIT,
  addTodo,
  authToken,
  editTodo,
  findOpenTodo,
  markerQuery,
} from "#jobs/things";

const LANDING = "anytime";
const TAG = "dotfiles";

// Runs on one cause before it moves to Today. Two nights of grace: a transient
// network failure or a flaky upstream clears by the second run, and what is left
// after three is something only Ben can fix.
export const ESCALATE_AFTER = 3;

const FIRST_RUN = 1;

// The prefix is distinctive enough that a to-do written by anything else cannot
// be mistaken for one of ours.
const MARKER_PREFIX = "dotfiles-job";

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

export function causeMarker(machine: string, job: string, cause: string): string {
  return `${MARKER_PREFIX} ${machine}/${job}/${cause}`;
}

export interface FailureNote {
  machine: string;
  time: string;
  revision: string;
  extraMeta: string;
  cause: string;
  logPath: string;
  marker: string;
  command: string;
  outputHeading: string;
  output: string;
}

export function buildNotes(note: FailureNote): string {
  let notes =
    `- **Machine:** ${note.machine}\n` +
    `- **First seen:** ${note.time}\n` +
    `- **Revision:** ${note.revision}`;
  if (note.extraMeta) notes += `\n${note.extraMeta}`;
  if (note.cause) notes += `\n- **Cause:** ${note.cause}`;
  notes += `\n- **Every run:** ${note.logPath}`;
  // Without the token nothing can be appended here, so the note says so once
  // rather than the runs after this one going unrecorded and unexplained.
  if (!authToken()) notes += `\n- **Appends are off:** ${TOKEN_REMEDY}`;
  notes += `\n\n\`${note.marker}\``;

  const suffix = "\n```";
  notes += `\n\n\`\`\`sh\n${note.command}\n\`\`\`\n\n## ${note.outputHeading}\n\`\`\`\n`;

  // The budget is what the limit leaves after the surrounding note, so this
  // subtraction and the one inside trimOutput have to agree or the note overruns.
  const trimmed = trimOutput(note.output, THINGS_NOTES_LIMIT - notes.length - suffix.length);
  // The closing fence sits on its own line directly after the last log line, so
  // trailing blank lines in the log would otherwise push it away from the text.
  return notes + trimmed.replace(TRAILING_NEWLINES, "") + suffix;
}

const TOKEN_REMEDY =
  "store the Things auth token as the `things-auth-token` keychain item";

// What a repeat adds to a to-do that already exists, sized to what the note has
// left and reduced to a pointer at the log where the output will not fit at all.
// The note says which of the two happened.
export function appendBlock(run: number, at: string, output: string, budget: number): string {
  const heading = `\n\n---\n\n### Run ${run} — ${at}\n`;
  const fences = "```\n";
  const remaining = budget - heading.length - fences.length - "```".length - 1;

  const trimmed = remaining < 0 ? "" : trimOutput(output, remaining);
  if (trimmed !== "") {
    return `${heading}${fences}${trimmed.replace(TRAILING_NEWLINES, "")}\n\`\`\``;
  }

  // An empty append-notes drops out of the URL, so the run count in the title
  // still lands and the run is still in the log.
  const pointer = `${heading}${POINTER}`;
  return pointer.length <= budget ? pointer : "";
}

const POINTER = "Output did not fit. It is in the log.";

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

// The machine belongs in the title because the two machines fail independently
// and their to-dos sync into one list. The run count belongs there because it is
// how a cause that is not clearing shows itself without being opened.
export function todoTitle(title: string, machine: string, runs: number): string {
  const named = `${title} on ${machine}`;
  return runs > 1 ? `${named} (${runs} runs)` : named;
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
  // Cause material the caller knows better than the generic derivation can. Empty
  // is the normal case, and means the cause comes from the command and the line
  // of output that names the failure.
  fingerprint: string;
}

// File a Things to-do for the failure, or append this run to the one already
// standing for it. Returns the exit status the CLI should carry: nonzero only
// when Things refused the URL.
export function reportFailure(report: FailureReport): number {
  const cause = report.fingerprint
    ? causeOf([report.fingerprint])
    : causeFingerprint(report.command, report.output);

  return file({
    report,
    cause,
    causeLine: distinctiveLine(report.output),
    latchJob: report.job,
  });
}

interface Filing {
  report: FailureReport;
  cause: string;
  // The line of output the cause was read from, for the note to name.
  causeLine: string;
  // The job whose latch stands in for Things where the store cannot be read.
  // Omitted by a caller that has already decided this report is new.
  latchJob?: string;
}

function file({ report, cause, causeLine, latchJob }: Filing): number {
  const machine = machineName();
  const marker = causeMarker(machineKeyOf(), report.job, cause);
  const at = timestamp();
  const runs = recordRun(report.job, cause, { at, output: report.output });

  const lookup = findOpenTodo(markerQuery(marker));
  const standing = lookup.readable ? lookup.todo : undefined;
  if (standing) {
    // A refused append leaves the standing to-do alone. It already names this
    // cause and the log holding every run, so a second one only adds noise.
    const appended = appendRun(standing, { report, machine }, { at, runs, cause });
    log(
      appended
        ? `${report.job} still failing on the same cause - appended run ${runs}`
        : `${report.job} still failing - the to-do already standing could not be appended to`,
    );
    // The latch follows the to-do it can see, so a later night that cannot read
    // the store holds the same answer instead of filing what it is blind to.
    if (latchJob) writeLatch(latchJob, latchValue(cause));
    return 0;
  }

  if (latchJob && !filesAgainst(latchJob, cause, lookup.readable)) {
    log(`${report.job} still failing - to-do already filed, staying quiet`);
    return 0;
  }

  log(`Creating Things to-do for ${report.job} failure`);
  // The new to-do counts from its own first run. Everything the finished one
  // carried stays in the archive, where it is history rather than this to-do's.
  resetRuns(report.job, cause);
  const notes = buildNotes({
    machine,
    time: at,
    revision: report.revision,
    extraMeta: report.extraMeta,
    cause: causeLine,
    logPath: runLogPath(report.job, cause),
    marker,
    command: report.command,
    outputHeading: report.outputHeading,
    output: report.output,
  });

  const title = todoTitle(report.title, machine, FIRST_RUN);
  const filed = addTodo({ title, notes, when: LANDING, tags: TAG });
  if (filed !== 0) return filed;

  notify(title, `${report.job} failed - see Things`);
  return 0;
}

// Whether a to-do should be filed, with the latch moved either way. A store read
// with nothing standing means the to-do was completed, so the cause returning is
// news whatever the latch says. A store that could not be read leaves the latch
// as the whole answer.
function filesAgainst(job: string, cause: string, finished: boolean): boolean {
  const latch = latchValue(cause);
  const prior = readLatch(job);
  // Moves before anything is filed, so a filing that fails stays quiet until the
  // job recovers or its cause moves.
  writeLatch(job, latch);
  return finished || prior !== latch;
}

function appendRun(
  standing: { id: string; notesLength: number },
  from: { report: FailureReport; machine: string },
  run: { at: string; runs: number; cause: string },
): boolean {
  const block = appendBlock(
    run.runs,
    run.at,
    from.report.output,
    THINGS_NOTES_LIMIT - standing.notesLength,
  );

  // Claimed rather than tested against the threshold for equality. A night the
  // store could not be read records its run without appending, so the count
  // steps over the threshold instead of landing on it.
  const escalating = run.runs >= ESCALATE_AFTER && claimEscalation(from.report.job, run.cause);

  const edited = editTodo({
    id: standing.id,
    appendNotes: block,
    title: todoTitle(from.report.title, from.machine, run.runs),
    when: escalating ? "today" : undefined,
  });

  // The update that would have carried the move to Today failed, so the claim
  // goes back rather than spending the one move on nothing.
  if (escalating && !edited) releaseEscalation(from.report.job, run.cause);
  return edited;
}

// Cached for the run: it costs two subprocesses and cannot change underneath one.
let machineKeyCache: string | undefined;

function machineKeyOf(): string {
  machineKeyCache ??= machineKey();
  return machineKeyCache;
}

// A finding is a subject and the verdict standing against it. The pair is the
// unit, because a plugin going from stale to pinned needs a different hand than
// the standing to-do describes.
export interface Finding {
  subject: string;
  verdict: string;
}

// Marks a latch holding a finding set rather than the single-failure ok/failed
// pair. A latch written in the other shape reads as no findings at all, so a job
// that changes mode files once and is consistent from there.
const FINDINGS_LATCH = "standing";

function findingKey(finding: Finding): string {
  return `${finding.subject}\t${finding.verdict}`;
}

function encodeFindings(findings: Finding[]): string {
  const rows = findings.map(findingKey);
  return [FINDINGS_LATCH, ...[...new Set(rows)].sort()].join("\n");
}

function decodeFindings(latch: string): Finding[] {
  const lines = latch.split("\n");
  if (lines[0] !== FINDINGS_LATCH) return [];

  return lines.slice(1).flatMap((line) => {
    const [subject, verdict] = line.split("\t");
    return subject === undefined || verdict === undefined ? [] : [{ subject, verdict }];
  });
}

export interface FindingsReport extends Omit<FailureReport, "fingerprint"> {
  // Every finding standing against the job this run.
  standing: Finding[];
  // Subjects the run could not reach a verdict on. Whatever the latch holds for
  // one of these survives the run.
  held: string[];
}

export interface FindingsDecision {
  fresh: Finding[];
  latched: Finding[];
}

// Which findings are newly standing, and what the latch should hold afterwards.
// A subject the run could not check keeps the verdict already latched for it,
// since nothing an unreachable host says is evidence a finding was fixed. Only a
// subject that came back clean, or is gone from the report, clears.
export function decideFindings(
  previous: Finding[],
  standing: Finding[],
  held: string[],
): FindingsDecision {
  const heldSubjects = new Set(held);
  const standingKeys = new Set(standing.map(findingKey));
  const previousKeys = new Set(previous.map(findingKey));

  const carried = previous.filter(
    (finding) => !standingKeys.has(findingKey(finding)) && heldSubjects.has(finding.subject),
  );

  return {
    fresh: standing.filter((finding) => !previousKeys.has(findingKey(finding))),
    latched: [...standing, ...carried],
  };
}

// The to-do carries the whole report, so it needs a line saying which part of it
// is why it was filed tonight. Without one, a report of five findings that fired
// because a sixth appeared reads as five new things to do.
function freshMeta(fresh: Finding[]): string {
  return `- **New:** ${fresh.map((finding) => `${finding.subject} ${finding.verdict}`).join(", ")}`;
}

// File a Things to-do for a job reporting a set of findings rather than one
// failure, for the newly standing findings alone. A finding already latched stays
// quiet however much the rest of the set churns around it. The cause is that
// fresh set, so the same set reappearing appends and a different one files.
export function reportFindings(report: FindingsReport): number {
  const decision = decideFindings(
    decodeFindings(readLatch(report.job)),
    report.standing,
    report.held,
  );
  // The latch moves before anything is filed, so a filing that fails leaves the
  // finding quiet rather than retrying it every night.
  writeLatch(report.job, encodeFindings(decision.latched));

  if (decision.fresh.length === 0) {
    log(`${report.job} has nothing newly standing - staying quiet`);
    return 0;
  }

  log(`Reporting new ${report.job} findings`);
  const cause = causeOf(decision.fresh.map(findingKey));
  return file({
    report: {
      ...report,
      extraMeta: [report.extraMeta, freshMeta(decision.fresh)].filter(Boolean).join("\n"),
    },
    cause,
    causeLine: decision.fresh.map((finding) => `${finding.subject} ${finding.verdict}`).join(", "),
  });
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
// Resolving the binary rather than reading process.platform lets a test put its
// own osascript on PATH. `display notification` sends no Apple event to another
// app, so unlike reading Things it needs no Automation grant under launchd.
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
