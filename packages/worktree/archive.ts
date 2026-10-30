// Snapshots a worktree's tracked and untracked files into a commit under
// refs/archive/wt/ before the pruner removes a dirty tree. Restore one with
// `git worktree add <path> <ref>`. Ignored files are not kept.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { EXPIRY } from "#worktree/branches";
import { capture, nowSeconds } from "#worktree/state";

export const NAMESPACE = "refs/archive/wt";
export const RETENTION = EXPIRY;

const SUBJECT = "wt archive:";

// The ref holding the snapshot, or undefined when any step fails, which callers
// treat as a reason not to remove the tree.
export async function archive(path: string, name: string): Promise<string | undefined> {
  const gitdir = await capture(["git", "-C", path, "rev-parse", "--absolute-git-dir"]);
  const head = await capture(["git", "-C", path, "rev-parse", "--verify", "-q", "HEAD"]);
  if (gitdir === "" || head === "") return undefined;
  // Files outside a sparse cone are absent from the tree, and `add -A` on a
  // fresh index would record them as deleted.
  if ((await git(path, ["config", "--bool", "core.sparseCheckout"])) === "true") return undefined;

  // A private index leaves the worktree's staged state untouched. It lives in
  // the git dir because macOS mktemp ignores TMPDIR.
  const index = join(gitdir, "wt-archive-index");
  rmSync(index, { force: true });
  try {
    const commit = await snapshot(path, head, name, { GIT_INDEX_FILE: index });
    return commit === undefined ? undefined : await record(path, name, commit);
  } finally {
    rmSync(index, { force: true });
  }
}

async function snapshot(
  path: string,
  head: string,
  name: string,
  env: Record<string, string>,
): Promise<string | undefined> {
  if ((await git(path, ["read-tree", head], env)) === undefined) return undefined;
  if ((await git(path, ["add", "-A"], env)) === undefined) return undefined;
  const tree = await git(path, ["write-tree"], env);
  if (tree === undefined || tree === "") return undefined;

  // Unsigned, because a locked Mac's signing agent would fail the nightly run.
  const commit = await git(
    path,
    ["commit-tree", "--no-gpg-sign", tree, "-p", head, "-m", `${SUBJECT} ${name} ${path}`],
    env,
  );
  return commit === "" ? undefined : commit;
}

// The empty old value makes update-ref refuse a ref that already exists. A
// second archive of one name on one day takes a suffixed ref instead.
async function record(path: string, name: string, commit: string): Promise<string | undefined> {
  const base = `${NAMESPACE}/${name}/${datestamp()}`;
  for (const ref of [base, `${base}-${commit.slice(0, 12)}`]) {
    if ((await git(path, ["update-ref", ref, commit, ""])) !== undefined) return ref;
  }
  return undefined;
}

function datestamp(): string {
  return new Date(nowSeconds() * 1000).toISOString().slice(0, 10).replaceAll("-", "");
}

// Deletes archive refs whose snapshot is older than `retentionSecs`, returning
// how many went. Only commits with the archive subject qualify, which leaves a
// branch archive under the same prefix alone.
export async function pruneArchives(retentionSecs: number, repo = "."): Promise<number> {
  const captured = await capture([
    "git",
    "-C",
    repo,
    "for-each-ref",
    NAMESPACE,
    "--format=%(refname)%09%(objectname)%09%(committerdate:unix)%09%(subject)",
  ]);

  let deleted = 0;
  for (const line of captured.split("\n")) {
    const [ref = "", object = "", date = "", subject = ""] = line.split("\t");
    if (ref === "" || !subject.startsWith(SUBJECT)) continue;
    if (!/^[0-9]+$/.test(date) || nowSeconds() - Number(date) < retentionSecs) continue;
    if ((await git(repo, ["update-ref", "-d", ref, object])) !== undefined) deleted += 1;
  }
  return deleted;
}

// Trimmed stdout, or undefined when git exits nonzero.
async function git(path: string, args: string[], env: Record<string, string> = {}): Promise<string | undefined> {
  const run = await $`git -C ${path} ${args} < /dev/null`
    .env({ ...process.env, ...env })
    .nothrow()
    .quiet();
  return run.exitCode === 0 ? run.stdout.toString().trim() : undefined;
}
