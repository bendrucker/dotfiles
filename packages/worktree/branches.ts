// Prunes branches no worktree holds. An archived branch is recoverable with
// `git branch <name> refs/archive/<name>` until EXPIRY.

import { $ } from "bun";
import { isSnapshot } from "#worktree/archive";
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

async function isBackedUp(tip: string, defaultName: string): Promise<boolean> {
  return (await capture(["git", "rev-list", "--count", tip, "--not", "--remotes", defaultName])) === "0";
}

// Reflog time, not commit time: `wt switch --create` branches from an old tip.
async function isStale(name: string, floor: number): Promise<boolean> {
  const times = await reflogTimes(`refs/heads/${name}`);
  if (times.length === 0) return true;
  return nowSeconds() - Math.max(...times) >= floor;
}

async function archiveTarget(name: string, tip: string): Promise<string> {
  const target = `refs/archive/${name}`;
  const existing = await capture(["git", "rev-parse", "--verify", "-q", target]);
  if (existing === "" || existing === tip) return target;
  const short = (await capture(["git", "rev-parse", "--short", tip])) || tip;
  return `${target}-${short}`;
}

async function archive(name: string, tip: string): Promise<boolean> {
  const target = await archiveTarget(name, tip);
  // A same-value update-ref writes no reflog entry, so recreate to restart expiry.
  const held = (await capture(["git", "rev-parse", "--verify", "-q", target])) === tip;
  if (held && !(await git(["update-ref", "-d", target]))) return false;
  if (!(await git(["update-ref", "--create-reflog", target, tip]))) return false;
  return await git(["branch", "-D", name]);
}

export interface BranchReport {
  branches: number;
  reasons: string[][];
}

// Without a parseable floor or a named default branch, touch no branch.
export async function pruneBranches(
  defaultName: string,
  minAge: string,
  dryRun: boolean,
  explaining: boolean,
  report: BranchReport,
): Promise<void> {
  const floor = parseDuration(minAge);
  const captured = floor === undefined || defaultName === "" ? undefined : await capture([
    "git",
    "for-each-ref",
    "refs/heads",
    "--format=%(refname:short)%09%(objectname)%09%(worktreepath)",
  ]);

  for (const branch of readBranches(captured ?? "", defaultName)) {
    if (!(await isStale(branch.name, floor ?? 0))) continue;

    const decision = decideBranch(await isBackedUp(branch.tip, defaultName));
    if (explaining) report.reasons.push(["-", branch.name, "-", decision.action, decision.reason]);

    const done = dryRun
      ? true
      : decision.action === "delete"
        ? await git(["branch", "-D", branch.name])
        : await archive(branch.name, branch.tip);
    if (done) report.branches += 1;
  }

  await expireArchives(dryRun, explaining, report);
}

// Keyed on the reflog's own date, since the archived commit is often already old.
// Worktree snapshots expire by commit date in pruneArchives instead.
async function expireArchives(dryRun: boolean, explaining: boolean, report: BranchReport): Promise<void> {
  const captured = await capture(["git", "for-each-ref", "refs/archive", "--format=%(refname)%09%(subject)"]);
  if (captured === "") return;

  for (const line of captured.split("\n").filter((line) => line !== "")) {
    const [ref = "", subject = ""] = line.split("\t");
    if (isSnapshot(ref, subject)) continue;
    const times = await reflogTimes(ref);
    if (times.length === 0) continue;
    if (nowSeconds() - Math.max(...times) < EXPIRY) continue;

    if (explaining) {
      report.reasons.push(["-", ref.replace(/^refs\/archive\//, ""), "-", "delete", "archive expired"]);
    }
    if (dryRun || (await git(["update-ref", "-d", ref]))) report.branches += 1;
  }
}

const REFLOG_DATE = /@\{(\d+)\}/;

async function reflogTimes(ref: string): Promise<number[]> {
  const captured = await capture(["git", "reflog", "show", "--date=unix", "--format=%gd", ref]);
  if (captured === "") return [];

  const times: number[] = [];
  for (const line of captured.split("\n")) {
    const match = REFLOG_DATE.exec(line);
    if (match !== undefined && match !== null) times.push(Number(match[1]));
  }
  return times;
}

async function git(args: string[]): Promise<boolean> {
  return (await $`git ${args} < /dev/null`.nothrow().quiet()).exitCode === 0;
}
