// The branch pass over refs/heads, run after the worktree passes so a branch
// nothing keeps checked out gets the same treatment a worktree's own branch
// gets from the forge pass, minus the forge: a branch with no worktree has no
// dirty tree to protect and nothing worth a network round-trip, so this
// decides purely from what git already knows about the ref.
//
// An archived branch is recoverable with `git branch <name> refs/archive/<name>`
// until EXPIRY.

import { minAge, nowSeconds, parseDuration } from "#worktree/state";

// How long an archived ref survives before recovery stops being plausible.
export const EXPIRY = 90 * 86400;

export interface Branch {
  name: string;
  tip: string;
}

// Local branches with no worktree of their own and not the default branch,
// which the worktree passes already own. `for-each-ref`'s own worktreepath
// field is what tells a branch checked out somewhere (including the main
// worktree) apart from one nothing holds, without a second call per branch.
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

// Pure: whether a branch is safe to delete outright turns only on whether its
// tip is backed up, never on a forge call. A squash-merged PR and a branch
// nobody ever opened a PR for look the same here, and that is the point: no
// worktree survives to ask the forge about.
export function decideBranch(backedUp: boolean): Decision {
  return backedUp
    ? { action: "delete", reason: "backed up" }
    : { action: "archive", reason: "local-only" };
}

// Zero means nothing here is only here.
function isBackedUp(tip: string, defaultName: string): boolean {
  const exclude = defaultName === "" ? [] : [defaultName];
  return capture(["git", "rev-list", "--count", tip, "--not", "--remotes", ...exclude]) === "0";
}

// The floor a branch's own reflog has to clear: its newest entry older than
// minAge(). The entry's own date, not the tip's commit date, because `wt
// switch --create` makes a branch on an old default-branch tip before its
// worktree exists. A branch with no reflog reads as old enough, since there
// is no signal saying it was touched recently.
function isStale(name: string): boolean {
  const floor = parseDuration(minAge()) ?? 0;
  const times = reflogTimes(`refs/heads/${name}`);
  if (times.length === 0) return true;
  return nowSeconds() - Math.max(...times) >= floor;
}

function archiveTarget(name: string, tip: string): string {
  const target = `refs/archive/${name}`;
  const existing = capture(["git", "rev-parse", "--verify", "-q", target]);
  if (existing === undefined || existing === "" || existing === tip) return target;
  const short = capture(["git", "rev-parse", "--short", tip]) ?? tip;
  return `${target}-${short}`;
}

// A failed update-ref leaves the branch alone rather than deleting work the
// archive step did not actually save.
function archive(name: string, tip: string): boolean {
  const target = archiveTarget(name, tip);
  if (!git(["update-ref", "--create-reflog", target, tip])) return false;
  return git(["branch", "-D", name]);
}

export interface BranchReport {
  branches: number;
  reasons: string[][];
}

// Runs whether or not
// any linked worktree survived the forge pass, since a branch can go
// worktree-less in a repo that only ever had the one checkout.
export function pruneBranches(
  defaultName: string,
  dryRun: boolean,
  explaining: boolean,
  report: BranchReport,
): void {
  const captured = capture([
    "git",
    "for-each-ref",
    "refs/heads",
    "--format=%(refname:short)%09%(objectname)%09%(worktreepath)",
  ]);

  for (const branch of readBranches(captured ?? "", defaultName)) {
    if (!isStale(branch.name)) continue;

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

// refs/archive/* left over from this pass or an earlier run, cleared once
// nothing could plausibly still want them. The timestamp this reads is the
// reflog entry's own date (%gd under --date=unix), not the archived commit's
// committer date: the latter is often already old the day something is
// archived, which would expire an archive the same night it was created.
function expireArchives(dryRun: boolean, explaining: boolean, report: BranchReport): void {
  const captured = capture(["git", "for-each-ref", "refs/archive", "--format=%(refname)"]);
  if (captured === undefined || captured === "") return;

  for (const ref of captured.split("\n").filter((line) => line !== "")) {
    const times = reflogTimes(ref);
    if (times.length === 0) continue;
    if (nowSeconds() - Math.min(...times) < EXPIRY) continue;

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

// Every spawn hands the environment over explicitly, because Bun otherwise
// resolves a bare command name against the PATH it captured at startup and a
// caller that adjusted PATH would reach a different binary than it meant to.
function capture(cmd: string[]): string | undefined {
  try {
    const run = Bun.spawnSync({ cmd, env: process.env, stdin: "ignore", stderr: "ignore" });
    return run.stdout.toString().replace(/\n+$/, "");
  } catch {
    return undefined;
  }
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
