// How long a worktree has sat untouched, which the pruner's age and archive
// passes judge it by. The tip commit is main's for a checkout with no commits
// of its own, and uncommitted edits leave no commit, so three times are read.

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { capture, nowSeconds, type Worktree, worktreeAgeSecs } from "#worktree/state";

// Seconds since the newest of the tip commit, the worktree's creation, and the
// last change to any path `git status` reports. Undefined when none of the
// three reads, which callers treat as a reason to keep the tree.
export async function idleSecs(worktree: Pick<Worktree, "path" | "timestamp">): Promise<number | undefined> {
  const now = nowSeconds();
  const age = await worktreeAgeSecs(worktree.path);
  const times = [
    worktree.timestamp > 0 ? worktree.timestamp : undefined,
    age === undefined ? undefined : now - age,
    await newestChange(worktree.path),
  ].filter((time): time is number => time !== undefined);

  if (times.length === 0) return undefined;
  return Math.max(0, now - Math.max(...times));
}

// The newest mtime among the paths `git status` lists, in seconds. Normal
// untracked mode lists an untracked directory once, and the directory's own
// mtime is what gets read. `--no-optional-locks` keeps status from rewriting
// the index of a tree someone may be working in.
export async function newestChange(path: string): Promise<number | undefined> {
  const captured = await capture([
    "git",
    "--no-optional-locks",
    "-C",
    path,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=normal",
  ]);

  let newest: number | undefined;
  for (const changed of statusPaths(captured)) {
    const modified = modifiedSeconds(join(path, changed));
    if (modified !== undefined && (newest === undefined || modified > newest)) newest = modified;
  }
  return newest;
}

// Each -z entry is "XY PATH", and a rename or copy follows it with the path it
// came from, which no longer exists in the tree.
export function statusPaths(captured: string): string[] {
  const fields = captured.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return paths;
}

function modifiedSeconds(path: string): number | undefined {
  try {
    return Math.floor(lstatSync(path).mtimeMs / 1000);
  } catch {
    return undefined;
  }
}
