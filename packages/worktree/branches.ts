// Prunes branches no worktree holds. An archived branch is recoverable with
// `git branch <name> refs/archive/<name>` until EXPIRY.

import type { Io } from "#io";
import { nowSeconds, parseDuration, QUIET, quietOutput } from "#worktree/state";

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

function isBackedUp(io: Io, tip: string, defaultName: string): boolean {
  return quietOutput(io, ["git", "rev-list", "--count", tip, "--not", "--remotes", defaultName]) === "0";
}

// Reflog time, not commit time: `wt switch --create` branches from an old tip.
function isStale(io: Io, name: string, floor: number): boolean {
  const times = reflogTimes(io, `refs/heads/${name}`);
  if (times.length === 0) return true;
  return nowSeconds() - Math.max(...times) >= floor;
}

function archiveTarget(io: Io, name: string, tip: string): string {
  const target = `refs/archive/${name}`;
  const existing = quietOutput(io, ["git", "rev-parse", "--verify", "-q", target]);
  if (existing === "" || existing === tip) return target;
  const short = quietOutput(io, ["git", "rev-parse", "--short", tip]) || tip;
  return `${target}-${short}`;
}

function archive(io: Io, name: string, tip: string): boolean {
  const target = archiveTarget(io, name, tip);
  // A same-value update-ref writes no reflog entry, so recreate to restart expiry.
  const held = quietOutput(io, ["git", "rev-parse", "--verify", "-q", target]) === tip;
  if (held && !git(io, ["update-ref", "-d", target])) return false;
  if (!git(io, ["update-ref", "--create-reflog", target, tip])) return false;
  return git(io, ["branch", "-D", name]);
}

export interface BranchReport {
  branches: number;
  reasons: string[][];
}

export interface PruneMode {
  dryRun: boolean;
  explaining: boolean;
}

// Without a parseable floor or a named default branch, touch no branch.
export function pruneBranches(
  io: Io,
  defaultName: string,
  minAge: string,
  { dryRun, explaining }: PruneMode,
  report: BranchReport,
): void {
  const floor = parseDuration(minAge);
  const captured = floor === undefined || defaultName === "" ? "" : quietOutput(io, [
    "git",
    "for-each-ref",
    "refs/heads",
    "--format=%(refname:short)%09%(objectname)%09%(worktreepath)",
  ]);

  for (const branch of readBranches(captured, defaultName)) {
    if (!isStale(io, branch.name, floor ?? 0)) continue;

    const decision = decideBranch(isBackedUp(io, branch.tip, defaultName));
    if (explaining) report.reasons.push(["-", branch.name, "-", decision.action, decision.reason]);

    const done = dryRun
      ? true
      : decision.action === "delete"
        ? git(io, ["branch", "-D", branch.name])
        : archive(io, branch.name, branch.tip);
    if (done) report.branches += 1;
  }

  expireArchives(io, dryRun, explaining, report);
}

// Keyed on the reflog's own date, since the archived commit is often already old.
function expireArchives(io: Io, dryRun: boolean, explaining: boolean, report: BranchReport): void {
  const captured = quietOutput(io, ["git", "for-each-ref", "refs/archive", "--format=%(refname)"]);
  if (captured === "") return;

  for (const ref of captured.split("\n").filter((line) => line !== "")) {
    const times = reflogTimes(io, ref);
    if (times.length === 0) continue;
    if (nowSeconds() - Math.max(...times) < EXPIRY) continue;

    if (explaining) {
      report.reasons.push(["-", ref.replace(/^refs\/archive\//, ""), "-", "delete", "archive expired"]);
    }
    if (dryRun || git(io, ["update-ref", "-d", ref])) report.branches += 1;
  }
}

const REFLOG_DATE = /@\{(\d+)\}/;

function reflogTimes(io: Io, ref: string): number[] {
  const captured = quietOutput(io, ["git", "reflog", "show", "--date=unix", "--format=%gd", ref]);
  if (captured === "") return [];

  const times: number[] = [];
  for (const line of captured.split("\n")) {
    const match = REFLOG_DATE.exec(line);
    if (match !== undefined && match !== null) times.push(Number(match[1]));
  }
  return times;
}

function git(io: Io, args: string[]): boolean {
  return io.read(["git", ...args], QUIET).status === 0;
}
