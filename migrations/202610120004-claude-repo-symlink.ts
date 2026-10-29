// ~/.claude-repo is cloned by [bootstrap.repos] now, which fails on a dangling
// symlink at that path where claude/install.sh used to replace it. A symlink to
// a clone is left in place, since mise accepts one.
//
// EXPIRES: 2027-01-12 every machine has run scripts/install since the move

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Context, linkTarget, removeTree } from "#migrations/migration";

export const platform = "darwin";

export async function up(context: Context): Promise<void> {
  const repo = join(context.home, ".claude-repo");
  if (linkTarget(repo) === undefined || existsSync(join(repo, ".git"))) return;

  await removeTree(context, repo);
}
