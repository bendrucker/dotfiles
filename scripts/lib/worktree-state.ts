// The worktree facts bin/wt-prune and bin/wt-prune-audit both read: how old a
// checkout is, what the forge says about its branch, which branch the repo
// treats as its default, and what `wt list` reports about the tree. The two
// scripts decide what to remove from these, and the audit exists to catch the
// pruner missing something, so a disagreement between them about a fact would
// read as drift in the pruner.
//
// bin/worktree-state is the CLI over this, and scripts/lib/worktree-state.sh
// the shim bin/wt-prune-audit sources while it is still zsh.

import { statSync } from "node:fs";
import { join } from "node:path";

// `wt step prune` refuses to remove a worktree younger than this, because a
// worktree just branched off main points at main's commit and so reads as
// integrated before any work happens in it. Named rather than left to
// worktrunk's default: the audit models the same deferral, and an oracle that
// does not report every worktree created since the last run as drift.
export const MIN_AGE_DEFAULT = "1d";

export function minAge(): string {
  // An empty override is no override. Nothing exports this, so `wt step prune`
  // sees it only through the flag bin/wt-prune passes.
  return process.env.WT_PRUNE_MIN_AGE || MIN_AGE_DEFAULT;
}

// A month is 30 days and a year 365, not calendar arithmetic. These durations
// name an age threshold, where a fixed span is the whole point and a boundary
// that moves with the month would make two runs disagree about the same
// worktree.
const UNIT_SECONDS: Record<string, number> = {
  h: 3600,
  d: 86400,
  w: 604800,
  mo: 2592000,
  y: 31536000,
};

const DURATION = /^([0-9]+)(h|d|w|mo|y)$/;

// Convert a duration like 2w / 30d / 1mo into seconds. Undefined on a spec it
// does not understand, which callers treat as a reason to stop rather than to
// guess: a silently wrong threshold either buries drift or removes work early.
export function parseDuration(spec: string): number | undefined {
  const match = DURATION.exec(spec);
  if (match === null) return undefined;
  return Number(match[1]) * UNIT_SECONDS[match[2]];
}

// Seconds since a worktree was created, on the same clock worktrunk's --min-age
// guard uses: the birth time of the per-worktree git dir, falling back to the
// mtime of the commondir file inside it. Both steps mirror worktrunk's own
// worktree_age (src/commands/step/prune.rs), so the two agree about which
// worktrees are too young to touch. Filesystems that record no birth time
// report 0, which is why the commondir fallback carries them.
//
// Undefined only when the path is gone or neither clock reads, and callers
// treat that as "old enough", matching worktrunk's handling of an age it cannot
// resolve.
//
// `wt list` carries only the tip commit's timestamp, which is main's tip for a
// worktree that has no commits of its own. Age derived from it says nothing
// about when the worktree appeared.
export function worktreeAgeSecs(worktreePath: string): number | undefined {
  const gitdir = capture(["git", "-C", worktreePath, "rev-parse", "--absolute-git-dir"]);
  if (gitdir === undefined || gitdir === "") return undefined;

  const created = birthSeconds(gitdir) ?? modifiedSeconds(join(gitdir, "commondir"));
  if (created === undefined) return undefined;
  return nowSeconds() - created;
}

function birthSeconds(path: string): number | undefined {
  const born = stat(path)?.birthtimeMs;
  // A filesystem that records no birth time reports zero, and the commondir
  // mtime is what carries it.
  return born !== undefined && born > 0 ? Math.floor(born / 1000) : undefined;
}

function modifiedSeconds(path: string): number | undefined {
  const modified = stat(path)?.mtimeMs;
  return modified !== undefined && modified > 0 ? Math.floor(modified / 1000) : undefined;
}

// The repo's default branch, empty when even worktrunk cannot name one.
//
// No prune pass can remove a linked worktree holding it: `wt step prune` skips
// the default branch, it has no PR of its own, and `wt remove` refuses it
// outright, since removing the checkout deletes the branch and force-delete is
// the only override. The pruner and the audit both gate on this name to stay
// out of a removal that cannot succeed.
//
// Asking worktrunk rather than reading git config is what makes the two agree:
// the same resolution guards `wt remove`, and it detects and caches on a miss
// instead of reporting nothing in a clone that has never been pruned.
export function defaultBranch(): string {
  return capture(["wt", "config", "state", "default-branch", "get"]) ?? "";
}

// The host of the origin remote, which decides whether gh or glab answers for
// this repo's branches. Empty when there is no origin, which routes to gh.
//
// Read from what .git/config holds, never through `git remote get-url`: that
// resolves url.<base>.insteadOf rewrites, so an org-wide rule can report a host
// the config never named, and a survivor routed to the wrong forge CLI comes
// back with no state and is deferred forever.
export function remoteHost(): string {
  const url = capture(["git", "config", "--get", "remote.origin.url"]) ?? "";
  // Drop any user@ prefix and any scheme, then keep everything up to the first
  // : or /, so git@github.com:o/r.git and https://github.com/o/r.git both name
  // github.com.
  const bare = url.replace(/^[^@]*@/, "").replace(/^https?:\/\//, "");
  return bare.split(/[:/]/)[0] ?? "";
}

export interface PullRequest {
  state: string;
  number: string;
}

// The exact PR/MR state for a branch on the forge, undefined when the branch
// has none. gh is the tested path; glab mirrors it (newest MR wins).
export function prState(branch: string, host: string): PullRequest | undefined {
  return host.includes("gitlab") ? mergeRequest(branch) : pullRequest(branch);
}

function pullRequest(branch: string): PullRequest | undefined {
  // The extraction stays in gh's own --jq rather than moving here: gh answers
  // in one tab-separated line, and a branch with no PR exits nonzero and prints
  // nothing, which is the same empty answer as a gh that is not installed.
  const captured = capture([
    "gh",
    "pr",
    "view",
    branch,
    "--json",
    "state,number",
    "--jq",
    '"\\(.state)\\t\\(.number)"',
  ]);
  if (captured === undefined || captured === "") return undefined;

  const [state, number] = captured.split("\t");
  return { state, number: number ?? "" };
}

function mergeRequest(branch: string): PullRequest | undefined {
  const captured = capture([
    "glab",
    "mr",
    "list",
    "--source-branch",
    branch,
    "--state",
    "all",
    "--output",
    "json",
  ]);
  if (captured === undefined || captured === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(captured);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  const newest = parsed[0];
  if (!isRecord(newest)) return undefined;

  const state = text(newest.state).toUpperCase();
  // GitLab's own word for an open MR, spelled the way the rest of this reads
  // it, so one classifier covers both forges.
  return { state: state === "OPENED" ? "OPEN" : state, number: scalar(newest.iid) };
}

const DIRT = ["staged", "modified", "untracked", "renamed", "deleted"] as const;

export interface Worktree {
  kind: string;
  branch: string;
  path: string;
  isMain: boolean;
  isCurrent: boolean;
  // The tip commit's timestamp, which is main's tip for a worktree that has no
  // commits of its own. See worktreeAgeSecs for what this is not.
  timestamp: number;
  clean: boolean;
  onRemote: boolean;
  mainState: string;
}

// Undefined when wt could not be run or said nothing a caller can read, which
// every caller treats as "no worktrees to consider" rather than as an empty
// repo.
export function listWorktrees(): Worktree[] | undefined {
  const captured = capture(["wt", "list", "--format=json"]);
  if (captured === undefined || captured === "") return undefined;
  return readWorktrees(captured);
}

export function readWorktrees(captured: string): Worktree[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(captured);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  return parsed.filter(isRecord).map(toWorktree);
}

function toWorktree(entry: Record<string, unknown>): Worktree {
  const commit = isRecord(entry.commit) ? entry.commit : {};
  const tree = isRecord(entry.working_tree) ? entry.working_tree : {};
  const remote = isRecord(entry.remote) ? entry.remote : undefined;

  return {
    kind: text(entry.kind),
    branch: text(entry.branch),
    path: text(entry.path),
    isMain: entry.is_main === true,
    isCurrent: entry.is_current === true,
    timestamp: typeof commit.timestamp === "number" ? commit.timestamp : 0,
    clean: !DIRT.some((field) => truthy(tree[field])),
    // A null remote, or one that reports no ahead count, reads as not backed
    // up: the tip is only recoverable when a remote holds every commit.
    onRemote: remote !== undefined && remote.ahead === 0,
    mainState: text(entry.main_state),
  };
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Every spawn hands the environment over explicitly, because Bun otherwise
// resolves a bare command name against the PATH it captured at startup and a
// caller that adjusted PATH would reach a different binary than it meant to.
// stdin is closed so a prompting command cannot eat what the caller is reading.
//
// A binary that is not installed throws here where the shell printed `command
// not found` and carried on. Caught rather than raised: every caller was
// written to degrade to doing nothing when its forge CLI or worktrunk is
// absent, and a prune that aborts is worse than one that removes nothing.
function capture(cmd: string[]): string | undefined {
  try {
    const run = Bun.spawnSync({ cmd, env: process.env, stdin: "ignore", stderr: "ignore" });
    return run.stdout.toString().replace(/\n+$/, "");
  } catch {
    return undefined;
  }
}

function stat(path: string) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Only null and false are quiet. A field carrying anything else says the
// working tree holds something, and reading an unrecognized value as clean is
// the direction that loses work.
function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}
