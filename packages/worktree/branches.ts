// Prunes branches no worktree holds. An archived branch is recoverable with
// `git branch <name> refs/archive/<name>` until EXPIRY.

import { capture, nowSeconds, parseDuration } from "#worktree/state";

export const EXPIRY = 90 * 86400;

export interface Branch {
  name: string;
  tip: string;
}

export function readBranches(captured: string, defaultName: string): Branch[] {
  return captured
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [name = "", tip = "", worktreepath = ""] = line.split("\t");
      return { name, tip, worktreepath };
    })
    .filter((entry) => entry.name !== "" && entry.worktreepath === "" && entry.name !== defaultName)
    .map(({ name, tip }) => ({ name, tip }));
}

export interface Decision {
  action: "delete" | "archive";
  reason: string;
}

export function decideBranch(backedUp: boolean): Decision {
  return backedUp
    ? { action: "delete", reason: "backed up" }
    : { action: "archive", reason: "local-only" };
}

function isBackedUp(tip: string, defaultName: string): boolean {
  return capture(["git", "rev-list", "--count", tip, "--not", "--remotes", defaultName]) === "0";
}

// Reflog time, not commit time: `wt switch --create` branches from an old tip.
function isStale(name: string, floor: number): boolean {
  const times = reflogTimes(`refs/heads/${name}`);
  if (times.length === 0) return true;
  return nowSeconds() - Math.max(...times) >= floor;
}

function archiveTarget(name: string, tip: string): string {
  const target = `refs/archive/${name}`;
  const existing = capture(["git", "rev-parse", "--verify", "-q", target]);
  if (existing === undefined || existing === "" || existing === tip) return target;
  const short = capture(["git", "rev-parse", "--short", tip]) || tip;
  return `${target}-${short}`;
}

function archive(name: string, tip: string): boolean {
  const target = archiveTarget(name, tip);
  // A same-value update-ref writes no reflog entry, so recreate to restart expiry.
  const held = capture(["git", "rev-parse", "--verify", "-q", target]) === tip;
  if (held && !git(["update-ref", "-d", target])) return false;
  if (!git(["update-ref", "--create-reflog", target, tip])) return false;
  return git(["branch", "-D", name]);
}

export interface BranchReport {
  branches: number;
  reasons: string[][];
}

// Without a parseable floor or a named default branch, touch no branch.
export function pruneBranches(
  defaultName: string,
  minAge: string,
  dryRun: boolean,
  explaining: boolean,
  report: BranchReport,
): void {
  const floor = parseDuration(minAge);
  const captured = floor === undefined || defaultName === "" ? undefined : capture([
    "git",
    "for-each-ref",
    "refs/heads",
    "--format=%(refname:short)%09%(objectname)%09%(worktreepath)",
  ]);

  for (const branch of readBranches(captured ?? "", defaultName)) {
    if (!isStale(branch.name, floor ?? 0)) continue;

    const decision = decideBranch(isBackedUp(branch.tip, defaultName));
    if (explaining) report.reasons.push(["-", branch.name, "-", decision.action, decision.reason]);

    const done = dryRun
      ? true
      : decision.action === "delete"
        ? git(["branch", "-D", branch.name])
        : archive(branch.name, branch.tip);
    if (done) report.branches += 1;
  }

  expireArchives(dryRun, explaining, report);
}

// Keyed on the reflog's own date, since the archived commit is often already old.
function expireArchives(dryRun: boolean, explaining: boolean, report: BranchReport): void {
  const captured = capture(["git", "for-each-ref", "refs/archive", "--format=%(refname)"]);
  if (captured === undefined || captured === "") return;

  for (const ref of captured.split("\n").filter((line) => line !== "")) {
    const times = reflogTimes(ref);
    if (times.length === 0) continue;
    if (nowSeconds() - Math.max(...times) < EXPIRY) continue;

    if (explaining) {
      report.reasons.push(["-", ref.replace(/^refs\/archive\//, ""), "-", "delete", "archive expired"]);
    }
    if (dryRun || git(["update-ref", "-d", ref])) report.branches += 1;
  }
}

const REFLOG_DATE = /@\{(\d+)\}/;

function reflogTimes(ref: string): number[] {
  const captured = capture(["git", "reflog", "show", "--date=unix", "--format=%gd", ref]);
  if (captured === undefined || captured === "") return [];

  const times: number[] = [];
  for (const line of captured.split("\n")) {
    const match = REFLOG_DATE.exec(line);
    if (match !== undefined && match !== null) times.push(Number(match[1]));
  }
  return times;
}

function git(args: string[]): boolean {
  try {
    const run = Bun.spawnSync({
      cmd: ["git", ...args],
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return run.exitCode === 0;
  } catch {
    return false;
  }
}
